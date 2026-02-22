# Dexter — Session Progress

> **Read this first in any new session.** Contains everything needed to pick up where the previous session left off.

---

## Git State

- **Branch:** `claude/create-progress-file-I7nxY`
- **Remote:** up to date — tree is clean
- **Latest commit:** `3bdf7ce` — Sprint 4 PROGRESS.md update (all sprints done)

---

## What Was Built (Complete Inventory)

### Critical bugs fixed (committed in `a8b51b3`)

| Bug | Fix location |
|---|---|
| Scheduler not notified when management agent creates a pipeline | `makeCreatePipelineTool(scheduler)` factory in `src/tools/daemon/management-tools.ts` |
| Collection and processing path disagreement | `outputDataPath` stored in pipeline JSON, used by both sides |
| WakeQueue race condition — events dropped under rapid push | Resolver array + while-loop drain in `src/daemon/wake-queue.ts` |
| Telegram accepts messages from anyone | `chatId` guard in `src/daemon/daemon.ts` — rejects unauthorized senders |
| Reactive agent blocks management/processing loop | Reactive agent spawned concurrently (`runReactiveAgent(...).catch(...)`) |
| `read_collected_data` allows arbitrary filesystem reads | Path validation restricted to `getCollectedDataDir()` |
| Default model was `gpt-5.2` (nonexistent) | Changed to `gpt-4o` |
| Profile load crash takes down daemon | `safeLoadProfile()` with `cachedProfile` fallback |
| Processing queued even when script wrote no data | `verifyDataWritten()` checks output dir before queuing |

### Sprint 1 remaining tasks (committed in `909bc92`)

| Task | What was done |
|---|---|
| **S1-3** WhatsApp alert delivery | `deliverMessage()` in `src/tools/daemon/alert-tools.ts` now calls `sendMessageWhatsApp()` from the gateway |
| **S1-4** Profile backup | `saveProfile()` copies `profile.json` → `profile.json.bak` before every write |
| **S1-5** Stuck pipeline reset | `resetStuckPipelines()` on every startup: pipelines stuck `running` for >10min reset to `scheduled` |
| **S1-6** Integration test suite | `src/daemon/daemon.test.ts` — 16 tests (39 total, all passing) |
| **S1-7** Deployment docs | `docs/DEPLOYMENT.md` — systemd unit, PM2, VPS sizing, WhatsApp gateway, backup/recovery |
| **Refactor** WakeQueue extraction | `src/daemon/wake-queue.ts` — class extracted from daemon.ts, now testable directly |
| **`DEXTER_DIR` env override** | `getDexterDir()` checks `process.env.DEXTER_DIR` first — used in tests for isolation |

### Documentation written (committed in `45b9b28`)

| File | Contents |
|---|---|
| `PRODUCT_SPEC.md` | Full PRD: personas, 5 user journeys, P0/P1/P2 requirements with acceptance criteria, KPIs |
| `ARCHITECTURE.md` | 16 components, ASCII data flow diagram, failure modes, security model, tech decisions |
| `EXECUTION_PLAN.md` | 4-sprint plan, 11 gap analysis items, 40-item launch checklist, 4-layer testing strategy |
| `docs/ARCHITECTURE.md` | Curated version grounded in actual file paths and function names |
| `docs/EXECUTION_PLAN.md` | Sprint plan with all 9 PE review bugs marked ✅ DONE, architecture decision log |
| `docs/DEPLOYMENT.md` | systemd, PM2, VPS (Hetzner/DO/Vultr), WhatsApp gateway, backup/recovery, security notes |

---

## Current Sprint Status

**Sprint 1: ✅ COMPLETE**
**Sprint 2: ✅ COMPLETE**

### Sprint 2 — What was built (committed in `47add09`)

| ID | Task | What was done |
|---|---|---|
| **S2-1** | Structured alert format | `send_alert` now requires 7 fields: `ticker`, `headline`, `specifics`, `thesisImpact`, `recommendation`, `nextCatalyst`, `urgency`. `formatAlertMessage()` renders clean HTML for Telegram. |
| **S2-2** | Management agent edge cases | Prompt updated: cancel pipelines for past events or removed tickers, enforce 90-day forward window, retry failed pipelines (rewrite script → test → reschedule). |
| **S2-3** | Morning briefing | `briefing_run` event type added. `buildBriefingAgentPrompt()` in `prompts.ts`. `briefingCron` wired in `daemon.ts` from profile delivery config. |
| **S2-4** | Richer `daemon:status` | Next run time per pipeline (croner), thesis coverage (holdings vs. thesis files), Telegram configured status, last management run timestamp from `daemon-state.json`. |
| **S2-5** | File permissions | `saveProfile()` calls `chmod(0o600)` after every write. |
| **S2-6** | Alert retry persistence | Failed alerts written to `~/.dexter/alerts-failed.jsonl`. `retryFailedAlerts()` called at daemon startup, removes successfully re-delivered entries. |
| **S2-7** | Test coverage | `src/daemon/sprint2.test.ts` — 30 new tests. Total: 67 tests, 0 failures (was 37). |

**Sprint 3: ✅ COMPLETE**

### Sprint 3 — What was built (committed in `18fcf0d`)

| ID | Task | What was done |
|---|---|---|
| **S3-1** | Script templates | `ex-dividend-collect.ts`, `filing-10q-collect.ts`, `filing-8k-collect.ts`, `price-alert-collect.ts` — each with retry logic and structured JSON output. |
| **S3-2** | Market context update | Management agent Step 0: check `read_market_context`; refresh via web search if absent or >7 days old / Monday. |
| **S3-3** | Portfolio drift detection | Management agent Step 1b: fetch current prices, compute position %, flag positions over `maxPositionPct`. `sendAlertTool` added to management toolset. |
| **S3-4** | Structured daemon logging | `src/utils/daemon-logger.ts`: NDJSON to `~/.dexter/daemon.log`, fire-and-forget, 10MB rotation to `daemon.log.1`. Wired into daemon/agent-runner key events. |
| **S3-5** | Startup preflight check | Prints formatted preflight summary before event loop. Exits 1 (hard fail) if no LLM key. Warns for missing Telegram/financial data. |
| **S3-6** | Test coverage | `src/daemon/sprint3.test.ts` — 18 tests: logger write/rotate, memory upsert, market context, pipelines edge cases, profile mutations, briefing_run routing. Total: **85 tests, 0 failures**. |
| **S3-7** | User documentation | `docs/DAEMON.md` — full guide (setup, status, pipeline lifecycle, thresholds, debug, FAQ, cost). `README.md` — Daemon Mode section. |

**Sprint 4: ✅ COMPLETE (code-implementable tasks)**

### Sprint 4 — What was built (committed in `acc6276`)

| ID | Task | What was done |
|---|---|---|
| **S4-3** | Security review | Fixed chatId guard (`&&` → `\|\|`): now rejects ALL senders when no profile configured. Documented explicit LLM key exclusion in `buildSafeEnv()`. Upgraded `.gitignore` pattern. Fixed DEPLOYMENT.md security note. |
| **S4-4** | Token cost logging | `agent-runner.ts` logs input/output token counts to `daemonLog` and console at agent completion and max-iterations. Queryable via `cat ~/.dexter/daemon.log \| jq 'select(.component \| startswith("agent:"))'`. |
| **S4-5** | Release prep | `package.json` bumped to `2026.2.22`. `CHANGELOG.md` written (full v1.0 entry). `docs/DEPLOYMENT.md` updated (security note fix). Local git tag `v2026.2.22` created. |

**Remaining S4 tasks (require live infra — not code):**
- S4-1: 72h live VPS test — requires real portfolio and cron to fire
- S4-2: Dogfood — requires internal users
- S4-4 (full): Actual cost measurement — requires real LLM runs with billing

---

## Test Suite

```bash
bun test                   # run all tests (85 tests, 9 files)
bun test --watch           # watch mode
bun test src/daemon/       # daemon tests only (62 tests, 3 files)
```

**Test files:**
- `src/daemon/daemon.test.ts` — WakeQueue, resetStuckPipelines, profile backup, pipeline lifecycle (16 tests)
- `src/daemon/sprint2.test.ts` — profile mutations, memory, pipelines, scheduler, alert retry (30 tests)
- `src/daemon/sprint3.test.ts` — logger, memory extended, pipelines edge cases, profile extended, briefing_run (18 tests)
- `src/gateway/access-control.test.ts` — gateway auth logic
- `src/utils/cache.test.ts` — cache key generation and round-trip

**Key test pattern:** `process.env.DEXTER_DIR = tmpDir` in `beforeEach` to isolate all file I/O into a temp directory. `delete process.env.DEXTER_DIR` in `afterEach`.

---

## Environment Setup

No `.env` file exists yet. Create one at the repository root:

```bash
# Required — daemon won't start without these
DEXTER_DAEMON_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=...              # from @BotFather on Telegram

# Required for pipeline data collection
FINANCIAL_DATASETS_API_KEY=...

# Required for management agent web search (at least one)
EXASEARCH_API_KEY=...
TAVILY_API_KEY=...

# Optional
ANTHROPIC_API_KEY=sk-ant-...        # if using Claude models
PERPLEXITY_API_KEY=...
OLLAMA_BASE_URL=http://localhost:11434

# Optional — override data directory (default: ~/.dexter)
# DEXTER_DIR=/custom/path
```

---

## How to Run

```bash
bun install                    # install dependencies
cp .env.example .env           # (no .env.example yet — create manually)
bun run daemon:setup           # interactive profile setup wizard
bun run daemon                 # start the daemon
bun run daemon:status          # show active pipelines + profile summary
bun test                       # run test suite
```

---

## Key Source Files

| File | Purpose |
|---|---|
| `src/daemon/daemon.ts` | Main orchestrator — `WealthAgentDaemon`, WakeQueue event loop, 3 agent runners |
| `src/daemon/wake-queue.ts` | `WakeQueue` class — async FIFO, concurrency-safe |
| `src/daemon/scheduler.ts` | `SchedulerEngine` — croner-based pipeline cron scheduling |
| `src/daemon/pipelines.ts` | Pipeline CRUD — reads/writes `~/.dexter/pipelines/*.json` |
| `src/daemon/profile.ts` | Financial profile store — `~/.dexter/profile.json` with `.bak` on save |
| `src/daemon/prompts.ts` | System prompt builders for management / processing / reactive agents |
| `src/daemon/agent-runner.ts` | `runDaemonAgent()` — LangChain agent execution with tool registry |
| `src/tools/daemon/alert-tools.ts` | `send_alert` tool — routes to Telegram or WhatsApp |
| `src/tools/daemon/management-tools.ts` | Tools for management agent (pipeline CRUD, script write/test) |
| `src/tools/daemon/processing-tools.ts` | Tools for processing agent (read data, read/update thesis, log action) |
| `src/gateway/channels/telegram/plugin.ts` | `TelegramChannel` class — grammy bot, send + receive |
| `src/gateway/channels/whatsapp/outbound.ts` | `sendMessageWhatsApp()` — baileys session |
| `src/daemon/index.ts` | CLI entry point — `daemon start`, `daemon:setup`, `daemon:status` |

---

## Data Directory Layout

```
~/.dexter/                         (overrideable via DEXTER_DIR)
├── profile.json                   # financial profile (goals, holdings, delivery config)
├── profile.json.bak               # auto-backup before every save
├── pipelines/                     # one JSON per pipeline
│   └── AAPL-earnings-1234567890.json
├── scripts/                       # agent-generated collection scripts
│   └── AAPL-earnings-1234567890-collect.ts
├── collected/                     # raw data from collection scripts
│   └── AAPL/earnings/2026-Q1/
│       └── results.json
└── memory/                        # thesis notes per ticker
    └── AAPL.md
```

---

## Key Source Files (full — updated for Sprint 4)

| File | What it does |
|---|---|
| `src/daemon/daemon.ts` | `WealthAgentDaemon` — preflight, event loop, 3 agent runners, pipeline fire, chatId guard |
| `src/daemon/wake-queue.ts` | `WakeQueue` — async FIFO, concurrency-safe push/next |
| `src/daemon/scheduler.ts` | `SchedulerEngine` — croner-based cron scheduling, live registration |
| `src/daemon/agent-runner.ts` | `runDaemonAgent()` — headless LangChain agent with daemon tools + token logging |
| `src/daemon/pipelines.ts` | Pipeline CRUD, `getCollectedDataDir()`, `getScriptsDir()` |
| `src/daemon/profile.ts` | Profile store — `0600` permissions, `.bak` on save, `safeLoadProfile()` |
| `src/daemon/memory.ts` | Thesis notes, action log (500-entry cap), market context |
| `src/daemon/prompts.ts` | Management (Step 0 market ctx, Step 1b drift), processing, briefing, reactive prompts |
| `src/daemon/tools.ts` | Per-agent tool sets (management + `sendAlertTool`, processing, reactive) |
| `src/daemon/index.ts` | CLI: `daemon`, `daemon:setup`, `daemon:status` |
| `src/daemon/setup.ts` | Interactive profile wizard |
| `src/tools/daemon/alert-tools.ts` | `send_alert` (7-field schema), `retryFailedAlerts()`, failed alert persistence |
| `src/tools/daemon/pipeline-tools.ts` | `create_pipeline` (live scheduler registration), `list_pipelines`, `cancel_pipeline` |
| `src/tools/daemon/memory-tools.ts` | `read_thesis`, `write_thesis`, `save_market_context`, `log_action` |
| `src/tools/daemon/profile-tools.ts` | `read_profile`, `add_holding`, `remove_holding`, `add_goal` |
| `src/tools/code/execute-script.ts` | `write_script`, `test_script`, `run_script` — sandboxed subprocess with env allowlist |
| `src/utils/daemon-logger.ts` | NDJSON logger → `~/.dexter/daemon.log`, 10MB rotation |
| `src/gateway/channels/telegram/plugin.ts` | `TelegramChannel` — grammy bot, inbound + outbound |
| `src/daemon/script-templates/` | 5 reference templates: earnings, ex-dividend, 10-Q, 8-K, price-alert |
| `docs/DAEMON.md` | Full user guide (setup, status, debug, FAQ, cost) |
| `docs/DEPLOYMENT.md` | systemd unit, PM2 config, VPS sizing, security notes |
| `CHANGELOG.md` | v1.0 release changelog |

## What NOT to Do Next Session

- Don't re-fix anything from Sprints 1–4 — all code work is committed and tested
- Don't rewrite `WakeQueue` or `SchedulerEngine` — both are correct and tested
- Don't create a `.env` with fabricated keys — wait for the user to provide real ones
- Don't push tags — the git server rejects tag pushes with HTTP 403

## All Sprints Complete

All code-implementable work from `EXECUTION_PLAN.md` Sprints 1–4 is done.

**Remaining items require live infrastructure** (not code):
- S4-1: 72h live VPS test
- S4-2: Dogfood with internal users
- S4-4 (full measurement): actual billing data from real LLM runs

The next logical step is to deploy on a VPS, run `bun run daemon:setup`, and let the system run through at least one real earnings pipeline cycle end-to-end.
