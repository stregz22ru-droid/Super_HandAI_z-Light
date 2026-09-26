// base2/runtime.ts — сборщик и РЕЕСТР синглтонов Base-этапа 2.
// Инициализируется ОДИН раз в startServer (server.ts) — независимо от того,
// кто бутит фичи (main.ts у меня / features/runtime.ts у команды): точка входа
// одна, дублирования нет (Ponytail).
// Фичи этапа (features/*.feature.js) получают доступ через getBase2().
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { AgentConfig } from '../config.js';
import type { TaskHub } from '../core/taskHub.js';
import { TaskService } from './taskService.js';
import { ModeStore } from './modeStore.js';
import { ModeGate } from './modeGate.js';
import { getSlotBus } from './slotBus.js';
import { AgentLink } from './mcp/agentLink.js';
import { TzQueue } from './autopilot/tzQueue.js';
import { BridgeIn } from './autopilot/bridgeIn.js';
import { AutopilotFsm } from './autopilot/fsm.js';
import { FsmPersist } from './autopilot/fsmPersist.js';
import { Outflow } from './autopilot/outflow.js';
import { Escalation } from './autopilot/escalation.js';
import { createBeforeRunCheck, type BeforeRunCheckHandle } from './check/directive.js';
import { MemoryStore } from './memory/store.js';

export interface Base2Runtime {
  cfg: AgentConfig;
  root: string;
  bus: ReturnType<typeof getSlotBus>;
  taskService: TaskService;
  modeStore: ModeStore;
  modeGate: ModeGate;
  queue: TzQueue;
  bridge: BridgeIn;
  fsm: AutopilotFsm;
  outflow: Outflow;
  escalation: Escalation;
  memory: MemoryStore;
  check: BeforeRunCheckHandle | null; // null, если фича check-directive выключена
}

export interface Base2InitDeps {
  cfg: AgentConfig;
  hub: TaskHub;
  reportsDir: string;
  logDir: string;
  broadcast: (msg: Record<string, unknown>) => void;
  agentToken: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  // Изоляция для смоука/тестов: SHAI_BASE2_ROOT переносит data/-слой этапа
  // (autopilot-state, memory, журналы моста/CHECK) в указанный корень.
  if (process.env.SHAI_BASE2_ROOT && process.env.SHAI_BASE2_ROOT.trim() !== '') {
    return resolvePath(process.env.SHAI_BASE2_ROOT);
  }
  // dist/base2/runtime.js → корень репо на 3 уровня выше; src/base2 → тоже 3.
  return resolvePath(__dirname, '..', '..', '..');
}

let rt: Base2Runtime | null = null;

export function initBase2Runtime(deps: Base2InitDeps): Base2Runtime {
  if (rt) return rt; // идемпотентно: повторный вызов возвращает существующий
  const root = repoRoot();
  const bus = getSlotBus();

  const taskService = new TaskService({
    cfg: deps.cfg,
    hub: deps.hub,
    reportsDir: deps.reportsDir,
    logDir: deps.logDir,
    broadcast: deps.broadcast,
  });

  const modeStore = new ModeStore();
  const modeGate = new ModeGate(modeStore, taskService);

  const queue = new TzQueue((deps.cfg.autopilot?.queueTtlSec ?? 600) * 1000);
  const outflow = new Outflow({
    root,
    agentToken: deps.agentToken,
    redaction: deps.cfg.redaction,
    defaultQuota: deps.cfg.autopilot?.outQuotaChars ?? 12000,
    log: (level, msg) => console.log(`[base2]${level === 'error' ? ' !' : ''} ${msg}`),
  });
  const escalation = new Escalation({
    root,
    reportsDir: deps.reportsDir,
    broadcast: deps.broadcast,
    outflow,
    trustedAgents: deps.cfg.helpers?.trustedAgents ?? [],
    helperAgentId: deps.cfg.autopilot?.helperAgentId ?? '',
    kFingerprints: deps.cfg.autopilot?.escalationFingerprintsK ?? 3,
    log: (level, msg) => console.log(`[base2]${level === 'error' ? ' !' : ''} ${msg}`),
  });
  const persist = new FsmPersist(root);
  const fsm = new AutopilotFsm({
    cfg: deps.cfg,
    hub: deps.hub,
    persist,
    queue,
    bridge: null,
    outflow,
    escalation,
    broadcast: deps.broadcast,
    log: (level, msg) => console.log(`[base2]${level === 'error' ? ' !' : ''} ${msg}`),
  });
  const bridge = new BridgeIn({
    modes: modeStore,
    tasks: taskService,
    queue,
    loop: fsm,
    root,
    log: (level, msg) => console.log(`[base2]${level === 'error' ? ' !' : ''} ${msg}`),
  });
  fsm.attachBridge(bridge);

  const memory = new MemoryStore(root);

  rt = {
    cfg: deps.cfg,
    root,
    bus,
    taskService,
    modeStore,
    modeGate,
    queue,
    bridge,
    fsm,
    outflow,
    escalation,
    memory,
    check: null,
  };

  fsm.start();
  memory.start();
  console.log('[base2] рантайм Этапа 2 инициализирован: taskService/modeStore/modeGate/bridge/fsm/outflow/escalation/memory');
  return rt;
}

export function getBase2(): Base2Runtime | null {
  return rt;
}

/** Для тестов: сброс синглтона (подписчики шины чистятся снаружи). */
export function resetBase2ForTest(): void {
  if (rt) {
    rt.fsm.stop();
    rt.memory.stop();
    rt.modeGate.dispose();
    rt.check?.dispose();
  }
  rt = null;
}

export { AgentLink };
