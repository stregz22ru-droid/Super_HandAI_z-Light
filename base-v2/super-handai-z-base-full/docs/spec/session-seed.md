# SESSION-SEED — паспорт контекста проекта Super_HandAI_z
Дата фиксации: 2026-09-06/07 · Статус: Light v1.0 ОПУБЛИКОВАН · Пауза по команде Мастера

## 1. ЛИНИЯ И РОЛИ
- **Мастер (Сергей, Бродип-Старый)** — владелец, ставит задачи, приёмка, «1 шаг = 1 команда»
- **Я (Hands-agent)** — разработчик/отладчик линии Light; регламент: полные файлы,
  no-scroll, через руки-ТЗ, факты прежде гипотез
- **Облачный ученик** (GLM, Linux-воркспейс) — построил AGP Этапы 1-3 ✅; ждёт
  фич-пакет (Registry+Слоты+Витрина+3 демо) — блок выдан, без права пуша в репо
- **Бродип (ученик 2)** — линия смыслов, Кристалл v1.0 существует, handshake состоялся
- **Критик-агент (ученица 3)** — приёмка/adversarial: дала И-логика EXPECT, cycle-не-retry,
  идемпотентность в промпт пака (→ spec v2.1 backlog)
- **AGP** = governance-шлюз: /check, /policies, kill-switch, ghostweave-аудит
  (хеш-цепь verify), rate-limit, policy-brief, batch, RESULT-notify. Коммит 9f39e87

## 2. ПРОДУКТ: Super_HandAI_z Light v1.0 — ОПУБЛИКОВАН
Репо: https://github.com/stregz22ru-droid/Super_HandAI_z-Light (master, e9bfcf0)
Роли: Light=полуавтомат(оператор-цикл) → Base=автомат(1-2 клика/задача) → Pro=роутинг
LLM+ноги+WCP+память. AGP-интеграция CHECK — мост между ними.
Стек: Windows-only, Node20 portable (C:\Utilit\node), pwsh7+PortableGit (runtime\),
agent (TS ESM: parser/stepEngine/guard/ptyManager/reporter/server/main),
public (xterm.js UI), мост (bridge.user.js v3.3 Tampermonkey chat.z.ai+GLM-5.3-Flash)

## 3. КЛЮЧЕВАЯ МЕХАНИКА (проверено живьём)
- Формат ТЗ: # ЗАДАЧ → # META(workdir new:|имя, mode auto|confirm, on_fail stop|continue,
  cycle=N-НЕ-retry) → ## ШАГ → RUN/RUN_BG+WAIT/WRITE/EXPECT/ASK/GIT/NOTE
- EXPECT: И-логика (несколько = AND), якорь обязан различать успех/провал
- Три рубежа пустых задач: парсер → парсер-META → server (steps.length===0)
- on_fail:continue работает (fix parser: metaObj.on_fail = meta.on_fail — был self-assign баг)
- Стабильный токен: data/state/agent.token (v4.2, fs-импорты синхронные!)
- purge: POST /workspace/purge БЕЗ токена, 409 при активной задаче
- cleanTail: маркер усечения, эхо-чистка (одно-символные строки-соседи)
- Мост: CodeMirror cm-content.cmView (полное чтение), каркасный детект ТЗ
  (#ЗАДАЧ+#META+##ШАГ где-то), линтер только RUN-скрипты, кнопка 🧹 (2 confirm)
- ConPTY-фантомы («ddocs») → правило: Test-Path прежде гипотезы
- Окружение: setup.ps1 (NOT cmd!), команды-генераторы файлов — антипаттерн

## 4. ОЧЕРЕДЬ (точная)
1. **README-START.md** — Мастер правит руками (setup.ps1, стабильный токен, purge)
2. **Фич-пакет облачному** — блок выдан (Registry+Слоты+Витрина+reflect/dry-run/
   context-pack) — он трудится в своём воркспейсе, дроп=архивом
3. **По дропу:** разведка нашим агентом → пуш/шлиф → ТЗ на Base ему же
4. **Base:** автопилот моста, supervisor-цикл, память проектов (ContextSeed-паттерн)
5. **AGP Этап 4:** директива CHECK в наши руки (risk-профиль→AGP→confirm)
6. **format-spec v2.1:** И-логика EXPECT, cycle-не-retry, идемпотентность, Test-Path
7. **13 фич от агентов** — картбланшHands в архитектуре «Ядро+Слоты+Витрина»
   (реестр: reflect, dry-run, context-pack, panic, safe-cleanup, x-ray, reproduce,
   time-machine, diff-locator, journal-search, inherit-packs, observer, multi-lang)

## 5. УРОКИ-АКСИОМЫ (FROZEN)
«Проверка = артефакт, не слова» · «Replay before Trust» · «Формат съедает всё,
что снаружи ограды» · «Предсказание вне канала — не предсказание» · «Якорь различает
успех/провал» · «Вывод — не улика до Test-Path» · «Два конца канала — разная упаковка» ·
«Правила — условия свободы» · «Бороться, искать, найти и не сдаваться»

## 6. РЕГЛАМЕНТ ВЗАИМОДЕЙСТВИЯ
1 шаг=1 задача=1 доклад · только полные файлы · no-scroll (всё в текущем сообщении) ·
правки через руки-ТЗ (бэкап→WRITE→Copy→EXPECT→build→commit) · факты прежде гипотез ·
границы: агент=машинное, человек=identity (GitHub/аутентификация) · файлы с вложенными
блоками — в обёртке 4+ бэктиков · node-однострочники для генерации файлов — антипаттерн

## 7. КОПИЛКА «ГОЛУБАЯ МЕЧТА» (не активировать без команды)
WCP v0.3 FROZEN · wcp_net · actor/relayx/ghostweave/policies · robolegacy/spex ·
ghostweave-core v1.0 (сертификат) · PROOF-пилот (Webots) · pilot-pandora (--task) ·
RelayRun (предок) · CLI-Anything (реестры, донор) · CLAIR (dormant, для API-эры) ·
AGP-доклад + ContextSeed · 13 фич агентов · конвергенция трёх линий доказана

## 8. ПРОТОКОЛ ВОССТАНОВЛЕНИЯ (для новой сессии)
Прочитай этот файл → подтверди понимание в 1 абзаце → жди команды Мастера →
первый шаг = п.4 очереди (README-START правки Мастера / дроп фич-пакета).