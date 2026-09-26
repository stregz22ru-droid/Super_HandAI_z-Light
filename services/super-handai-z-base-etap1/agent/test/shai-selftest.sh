#!/usr/bin/env bash
# test/shai-selftest.sh — e2e самотест «Системы фич» (Super_HandAI_z Light).
# Маркеры: FEAT-GATE, FEAT-LIST, SUBMODE-UI, TOGGLE-PERSIST, TOGGLE-RESTART, REFLECT,
#          CTX-PACK, FEAT-UPLOAD-BAD, FEAT-UPLOAD-OK, FEAT-DELETE,
#          FEAT-DELETE-BUNDLED, DRY-SKIP, HOOKS-CTX, MCP-SMOKE, SKILL-SYNC, SMOKE
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
DATAROOT="$(cd "$ROOT/.." && pwd)"
PORT=8791
BASE="http://127.0.0.1:$PORT"
PASS=1
fail() { PASS=0; echo "  !! ОШИБКА на предыдущем маркере"; }

pkill -f "node dist/main.js" 2>/dev/null || true
sleep 0.5

# --- конфиг e2e (data/state в .gitignore) ---
mkdir -p "$DATAROOT/data/state" "$ROOT/workspace/e2e-ws"
cat > "$DATAROOT/data/state/config.json" <<EOF
{
  "port": $PORT,
  "workspaceRoot": "$ROOT/workspace/e2e-ws",
  "features": {
    "reflect": true,
    "dry-run": true,
    "context-pack": true,
    "dry-run-active": true
  }
}
EOF

start_server() {
  nohup node dist/main.js > server-e2e.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/health" && return 0
    sleep 0.25
  done
  echo "СЕРВЕР НЕ СТАРТОВАЛ"; tail -20 server-e2e.log; exit 1
}
start_server
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

TOKEN=$(cat "$DATAROOT/data/state/last-token.txt" 2>/dev/null)
[ -n "$TOKEN" ] || { echo "нет токена"; exit 1; }
TZDIR=$(mktemp -d)

# --- ТЗ-файлы ---
cat > "$TZDIR/tz-echo.txt" <<'EOF'
# ЗАДАЧ: E2E single echo
# META
workdir: new:e2e-echo
mode: auto
on_fail: stop
cycle: 1

## ШАГ 1. эхо
RUN shell: bash
```bash
echo dry-e2e
```
EXPECT exit=0
EOF

cat > "$TZDIR/tz-3steps.txt" <<'EOF'
# ЗАДАЧ: E2E reflect
# META
workdir: new:e2e-reflect
mode: auto
on_fail: continue
cycle: 1

## ШАГ 1. эхо-1
RUN shell: bash
```bash
echo step-one
```
EXPECT exit=0

## ШАГ 2. эхо-2
RUN shell: bash
```bash
echo step-two
```
EXPECT exit=0

## ШАГ 3. эхо-3
RUN shell: bash
```bash
echo step-three
```
EXPECT exit=0
EOF

code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "=== Система фич: e2e ==="

# 1) токен-гейт
gate=$(code_of "$BASE/features")
gate2=$(code_of "$BASE/features?t=wrong-token")
echo "FEAT-GATE: без-токена=$gate с-неверным=$gate2"
[ "$gate" = "403" ]  || fail
[ "$gate2" = "403" ] || fail

# 2) список фич: три bundled загружены
list=$(curl -s "$BASE/features?t=$TOKEN")
names=$(node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const o=JSON.parse(s);const f=Object.fromEntries(o.features.map(x=>[x.name,x]));console.log([['reflect','dry-run','context-pack'].every(n=>f[n]&&f[n].loaded&&f[n].bundled),'ok'].join('|'))})" <<< "$list")
echo "FEAT-LIST: all-bundled-loaded=${names%%|*}"
[ "${names%%|*}" = "true" ] || fail

# 2b) SUBMODE-UI: подрежимы в GET /features (данные для one-click тумблера OPERATOR-панели)
sub=$(curl -s "$BASE/features?t=$TOKEN")
subok=$(node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const o=JSON.parse(s);const sm=(o.submodes||[]).find(x=>x.name==='dry-run-active');console.log(sm&&sm.feature==='dry-run'&&sm.enabled===true&&sm.featureEnabled===true?'ok':'нет')})" <<< "$sub")
echo "SUBMODE-UI: submodes.dry-run-active (feature=dry-run, enabled=true, featureEnabled=true) = $subok"
[ "$subok" = "ok" ] || fail

# 3) toggle выключает подрежим и ПЕРСИСТИТ в config.json
tog=$(curl -s -X POST "$BASE/features/toggle?t=$TOKEN" -H 'content-type: application/json' -d '{"name":"dry-run-active","enabled":false}')
persist=$(node -e "const c=require('$DATAROOT/data/state/config.json');console.log(c.features['dry-run-active']===false&&c.features['dry-run']===true?'да':'нет')")
echo "TOGGLE-PERSIST: dry-run-active=false записан в config.json: $persist"
[ "$persist" = "да" ] || fail
togok=$(node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{try{console.log(String(JSON.parse(s).ok))}catch{console.log('нет')}})" <<< "$tog")
[ "$togok" = "true" ] || fail

# 4) рестарт — подрежим остался выключенным (сохранение между рестартами)
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null
sleep 0.5
start_server
TOKEN=$(cat "$DATAROOT/data/state/last-token.txt")
persist2=$(node -e "const c=require('$DATAROOT/data/state/config.json');console.log(c.features['dry-run-active']===false?'да':'нет')")
echo "TOGGLE-RESTART: после рестарта dry-run-active=false: $persist2"
[ "$persist2" = "да" ] || fail

# 5) REFLECT: 3 RUN-шага → чек-лист самонадзора в терминале
wsout="$TZDIR/reflect.out"
node "$ROOT/test/ws-client.mjs" "$PORT" "$TOKEN" "$TZDIR/tz-3steps.txt" > "$wsout" 2>&1
rc=$?
refl=$(grep -c '\[REFLECT\]' "$wsout" || true)
chkl=$(grep -c 'чек-лист самонадзора' "$wsout" || true)
status3=$(grep -o 'TASK_DONE_STATUS: [A-Z]*' "$wsout" | awk '{print $2}')
echo "REFLECT: reflect-строк=$refl чек-лист=$chkl статус=$status3 (rc=$rc)"
[ "$rc" = "0" ]    || fail
[ "$refl" -ge 1 ]  || fail
[ "$chkl" -ge 1 ]  || fail
[ "$status3" = "SUCCESS" ] || fail

# 6) CTX-PACK: markdown-артефакт
ctx=$(curl -s "$BASE/features/context-pack?t=$TOKEN")
ctxok=$(node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const ok=s.includes('# Context Pack')&&s.includes('## git status')&&s.includes('## config')&&s.includes('## journal')&&s.includes('\"reflect\"');console.log(ok?'да':'нет')})" <<< "$ctx")
echo "CTX-PACK: markdown-секции= $ctxok"
echo "$ctxok" | grep -q "да" || fail
[ "$(code_of "$BASE/features/context-pack")" = "403" ] || fail

# 7) upload: битый файл → 400, валидный → 200 + файл в agent/features
bad=$(code_of -X POST "$BASE/features/upload?t=$TOKEN&filename=broken.feature.js" -H 'content-type: application/javascript' --data-binary 'это (( не фича')
cat > "$TZDIR/e2e-log.feature.js" <<'EOF'
export const manifest = { name: 'e2e-log', title: 'E2E log', description: 'временная фича e2e', version: '1.0.0', slot: ['afterRun'], dependencies: [], minCore: '1.0.0' };
export function create(ctx) { return { afterRun(i, info) { ctx.log('info', '[E2E-LOG] ' + i); } }; }
EOF
good=$(code_of -X POST "$BASE/features/upload?t=$TOKEN&filename=e2e-log.feature.js" -H 'content-type: application/javascript' --data-binary @"$TZDIR/e2e-log.feature.js")
fexists=$([ -f "$ROOT/features/e2e-log.feature.js" ] && echo да || echo нет)
echo "FEAT-UPLOAD-BAD: $bad (ожидаем 400)"
[ "$bad" = "400" ] || fail
echo "FEAT-UPLOAD-OK: $good файл-на-диске=$fexists (ожидаем 200)"
[ "$good" = "200" ] || fail
[ "$fexists" = "да" ] || fail

# 8) delete: bundled → 403, загруженная → 200 (файл исчез)
delb=$(code_of -X DELETE "$BASE/features/reflect?t=$TOKEN")
delg=$(code_of -X DELETE "$BASE/features/e2e-log?t=$TOKEN")
fgone=$([ -f "$ROOT/features/e2e-log.feature.js" ] && echo нет || echo да)
echo "FEAT-DELETE-BUNDLED: $delb (ожидаем 403)"
[ "$delb" = "403" ] || fail
echo "FEAT-DELETE: $delg файл-удалён=$fgone (ожидаем 200/да)"
[ "$delg" = "200" ] || fail
[ "$fgone" = "да" ] || fail

# 9) DRY-SKIP: подрежим включается toggle'ом БЕЗ рестарта → RUN пропущен
curl -s -X POST "$BASE/features/toggle?t=$TOKEN" -H 'content-type: application/json' -d '{"name":"dry-run-active","enabled":true}' > /dev/null
dryout="$TZDIR/dry.out"
node "$ROOT/test/ws-client.mjs" "$PORT" "$TOKEN" "$TZDIR/tz-echo.txt" > "$dryout" 2>&1
rc=$?
dry=$(grep -c '\[DRY\] было бы: echo dry-e2e' "$dryout" || true)
skip=$(grep -c '\[SKIP\] RUN: dry-run' "$dryout" || true)
statusd=$(grep -o 'TASK_DONE_STATUS: [A-Z]*' "$dryout" | awk '{print $2}')
execd=$(grep -c '^dry-e2e$' "$dryout" || true)   # фактический вывод echo — НЕ должен появиться
echo "DRY-SKIP: dry-строк=$dry skip-строк=$skip статус=$statusd исполнений=$execd (rc=$rc)"
[ "$rc" = "0" ]   || fail
[ "$dry" -ge 1 ]  || fail
[ "$skip" -ge 1 ] || fail
[ "$statusd" = "SUCCESS" ] || fail
[ "$execd" = "0" ]  || fail

# 10) HOOKS-CTX (ЭТАП 1, 2.4): внешний хук *.hook.js — plain node, BOM/CRLF-гигиена,
#     additionalContext в терминал и журнал; never-block (бюджет) не роняет задачу
cat > "$ROOT/hooks/e2e.hook.js" <<'EOF'
console.log('HOOK-E2E: контекст на сессию готов');
EOF
hookout="$TZDIR/hook.out"
node "$ROOT/test/ws-client.mjs" "$PORT" "$TOKEN" "$TZDIR/tz-echo.txt" > "$hookout" 2>&1
rc=$?
hooklog=$(grep -c '\[hook:e2e.hook.js\] HOOK-E2E' "$hookout" || true)
ctxline=$(grep -c '\[ctx\]' "$hookout" || true)
hstatus=$(grep -o 'TASK_DONE_STATUS: [A-Z]*' "$hookout" | awk '{print $2}')
journal_hook=$(grep -c 'HOOK-E2E' "$DATAROOT/data/state/journal.jsonl" 2>/dev/null || true)
echo "HOOKS-CTX: хук-строк=$hooklog ctx-строк=$ctxline журнал=$journal_hook статус=$hstatus (rc=$rc)"
rm -f "$ROOT/hooks/e2e.hook.js"
[ "$rc" = "0" ]      || fail
[ "$hooklog" -ge 1 ] || fail
[ "$hstatus" = "SUCCESS" ] || fail
[ "$journal_hook" -ge 1 ] || fail

# 11) MCP-SMOKE (ЭТАП 1, МОДУЛЬ 1): реальный stdio-процесс dist/mcp.js —
#     run_tz → taskId → get_status → task.done + lock + toggle + purge
mcpout="$TZDIR/mcp.out"
node "$ROOT/test/mcp-smoke.mjs" > "$mcpout" 2>&1
mcprc=$?
mcpdone=$(grep -c 'MCP-SMOKE-TASK-DONE\]: SUCCESS' "$mcpout" || true)
echo "MCP-SMOKE: rc=$mcprc task.done=$mcpdone"
[ "$mcprc" = "0" ]   || { fail; tail -n 20 "$mcpout"; }
[ "$mcpdone" -ge 1 ] || fail

# 12) SKILL-SYNC (ЭТАП 1, МОДУЛЬ 3): пак ↔ SKILL.md парны (дрейф ловится)
node "$ROOT/dist/skillconv.js" check --pack "$DATAROOT/scilss_agent/packs/web-dev" --skill "$DATAROOT/skills/web-dev" > "$TZDIR/skill.out" 2>&1
skillrc=$?
echo "SKILL-SYNC: rc=$skillrc ($(tail -n 1 "$TZDIR/skill.out"))"
[ "$skillrc" = "0" ] || { fail; cat "$TZDIR/skill.out"; }

pkill -f "node dist/main.js" 2>/dev/null || true
rm -rf "$TZDIR"

if [ "$PASS" = "1" ]; then
  echo "SMOKE: PASS"
  exit 0
else
  echo "SMOKE: FAIL"
  [ -s server-e2e.log ] && { echo '--- server-e2e.log (tail) ---'; tail -n 30 server-e2e.log; }
  exit 1
fi
