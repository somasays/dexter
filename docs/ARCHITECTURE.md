# Dexter Daemon — Technical Architecture Document

**Version:** 1.0
**Date:** 2026-02-21
**Status:** Ground Truth for Engineering

---

## System Overview

Dexter Daemon is a long-running Node.js/Bun process that orchestrates three LLM-powered agents via an event-driven wake queue. It has no persistent server, no database, and no network-exposed ports. All state is stored as JSON files in `~/.dexter/`. External communication is exclusively outbound (to LLM APIs and financial data APIs) and through the Telegram Bot API (bidirectional).

### Primary Components

1. **WealthAgentDaemon** — the process root. Owns the wake queue, the cron scheduler, and the Telegram channel. Starts, routes events, and shuts down cleanly.
2. **WakeQueue** — an async FIFO queue that decouples event producers (cron jobs, Telegram inbound, pipeline completions) from the agent runner. The daemon sleeps (zero CPU) when the queue is empty.
3. **SchedulerEngine** — wraps `croner`. Maps pipeline IDs to active `Cron` jobs. Restores schedules from disk on startup. Fires a subprocess and then enqueues a `pipeline_complete` event.
4. **Management Agent** — a headless LLM agent that runs daily. Responsible for discovering events, writing and testing collection scripts, creating pipelines, and maintaining thesis notes.
5. **Processing Agent** — a headless LLM agent that runs after every pipeline fires. Reads collected data, compares against thesis and analyst consensus, decides ALERT or NO_ACTION.
6. **Reactive Agent** — a headless LLM agent that runs for every inbound user message. Has full tool access including pipeline creation and ad-hoc code execution.
7. **DaemonAgentRunner** — the shared headless agent loop. Identical to the interactive CLI agent loop but without UI callbacks, with auto-approval for file writes, and with daemon-specific tool sets.
8. **Financial Profile Store** — JSON-backed CRUD layer for `~/.dexter/profile.json`. The source of truth for user identity, portfolio, goals, delivery preferences, and risk parameters.
9. **Pipeline Store** — JSON-backed CRUD layer for `~/.dexter/pipelines/{id}.json`. The source of truth for all scheduled and historical data collection jobs.
10. **Thesis Memory Store** — JSON-backed store for `~/.dexter/memory/{TICKER}-thesis.json` and `action-log.json`. Per-ticker living documents maintained by agents across sessions.
11. **Code Execution Sandbox** — Bun subprocess runner with stripped environment. Runs agent-written TypeScript scripts with a timeout and output size limit.
12. **Telegram Channel** — `grammy`-based long-polling bot. Receives inbound messages and delivers alerts. Singleton; started by the daemon and shared with the alert tools.
13. **WhatsApp Channel** — `@whiskeysockets/baileys`-based WA channel. Receives messages from self-chat or allowlisted numbers. Session stored in `~/.dexter/credentials/whatsapp/`.
14. **Tool Registry** — Returns the correct tool set for each agent type. Management, processing, and reactive agents get different tool subsets.
15. **Financial Data Layer** — Wraps `financialdatasets.ai` API. Provides income statements, balance sheets, cash flows, key ratios, estimates, prices, insider trades, company facts, earnings transcripts, SEC filings.
16. **Web Search Layer** — Exa (preferred) or Tavily (fallback). Used by management and reactive agents to discover earnings calendars and recent news.

---

## Data Flow

```
                          ┌────────────────────────────────────────────────────────┐
                          │                   DEXTER DAEMON PROCESS                │
                          │                                                        │
  ┌──────────┐  message   │  ┌──────────────┐    push event    ┌───────────────┐  │
  │ Telegram │──────────► │  │ TelegramChan  │ ───────────────► │               │  │
  │  (user)  │◄──────────  │  │   (grammy)   │                  │   WakeQueue   │  │
  └──────────┘  send reply │  └──────────────┘                  │  (async FIFO) │  │
                          │                                      │               │  │
  ┌──────────┐  message   │  ┌──────────────┐    push event    │               │  │
  │ WhatsApp │──────────► │  │   WhatsApp   │ ───────────────► │               │  │
  │  (user)  │◄──────────  │  │   Channel    │                  │               │  │
  └──────────┘  send reply │  └──────────────┘                  │               │  │
                          │                                      │               │  │
                          │  ┌──────────────┐    push event    │               │  │
                          │  │  Cron Jobs   │ ───────────────► │               │  │
                          │  │  (croner)    │                  │               │  │
                          │  │ - daily mgmt │                  └──────┬────────┘  │
                          │  │ - pipelines  │                         │           │
                          │  └──────────────┘                         │ next()    │
                          │                                           ▼           │
                          │                               ┌───────────────────┐   │
                          │                               │   Event Router    │   │
                          │                               │   handleEvent()   │   │
                          │                               └─────────┬─────────┘   │
                          │                                         │             │
                          │              ┌──────────────────────────┼──────────┐  │
                          │              │                          │          │  │
                          │              ▼                          ▼          ▼  │
                          │  ┌──────────────────┐  ┌────────────────────┐  ┌─────────────┐  │
                          │  │  Management      │  │  Processing        │  │  Reactive   │  │
                          │  │  Agent           │  │  Agent             │  │  Agent      │  │
                          │  │                  │  │                    │  │             │  │
                          │  │ Tools:           │  │ Tools:             │  │ Tools:      │  │
                          │  │ - profile R/W    │  │ - profile R        │  │ - profile   │  │
                          │  │ - thesis R/W     │  │ - thesis R/W       │  │   R/W       │  │
                          │  │ - pipeline CRUD  │  │ - read_collected   │  │ - thesis R/W│  │
                          │  │ - write_script   │  │ - send_alert       │  │ - pipelines │  │
                          │  │ - test_script    │  │ - fin. search      │  │ - write/run │  │
                          │  │ - fin. search    │  │ - web search       │  │   scripts   │  │
                          │  │ - web search     │  │ - log_action       │  │ - send_reply│  │
                          │  └──────┬───────────┘  └────────┬───────────┘  └──────┬──────┘  │
                          │         │                        │                     │   │
                          └─────────┼────────────────────────┼─────────────────────┼───┘
                                    │                        │                     │
          ┌─────────────────────────┴────────────────────────┴─────────────────────┴───────────────────┐
          │                             SHARED INFRASTRUCTURE                                          │
          │                                                                                            │
          │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────┐  │
          │  │ Financial       │  │ Web Search      │  │ ~/.dexter/       │  │ Code Sandbox       │  │
          │  │ Datasets API    │  │ Exa / Tavily    │  │ File Store       │  │ (Bun subprocess    │  │
          │  │ (financials,    │  │                 │  │ profile.json     │  │  stripped env)     │  │
          │  │  filings,       │  │                 │  │ pipelines/       │  │                    │  │
          │  │  transcripts)   │  │                 │  │ memory/          │  │ 30s timeout        │  │
          │  └─────────────────┘  └─────────────────┘  │ scripts/         │  │ 50KB stdout limit  │  │
          │                                             │ collected/       │  └────────────────────┘  │
          │  ┌─────────────────┐  ┌─────────────────┐  └──────────────────┘                          │
          │  │ LLM Providers   │  │ Telegram Bot    │                                                │
          │  │ OpenAI / Anthro │  │ API (grammy)    │                                                │
          │  │ Google / xAI /  │  │                 │                                                │
          │  │ Ollama          │  │                 │                                                │
          │  └─────────────────┘  └─────────────────┘                                                │
          └────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### WealthAgentDaemon (`src/daemon/daemon.ts`)

The process root. Initializes the SchedulerEngine, the TelegramChannel singleton, and the WakeQueue. On `start()`, it restores pipeline schedules from disk, connects Telegram polling, schedules the daily management cron (6am UTC), triggers an immediate startup management run, and enters `runEventLoop()`. The event loop blocks on `wakeQueue.next()` — a zero-CPU await that returns when a new event arrives. Each event is dispatched to the appropriate agent runner. Errors in the event loop are caught, logged, and do not kill the loop. `stop()` cancels all crons, stops Telegram polling, and exits cleanly.

**Key implementation notes:**
- `WakeQueue` uses a `resolvers: Array<() => void>` array + while-loop drain to prevent race conditions when multiple events arrive rapidly
- Reactive agent messages run concurrently (`.catch(...)` without await) to prevent user messages from blocking scheduled pipeline work
- `verifyDataWritten(dirPath)` checks that files actually exist before queuing `pipeline_complete`
- `safeLoadProfile()` catches JSON parse errors and falls back to a cached profile

### WakeQueue (`src/daemon/daemon.ts`)

A minimal async FIFO. Producers call `push(event)`; the event loop calls `await next()`. When the queue is empty, `next()` suspends via a Promise that is resolved by the next `push()`. The resolver array pattern prevents event loss when rapid concurrent events arrive. Zero-CPU; no polling, no `setInterval`, no busy-wait.

### SchedulerEngine (`src/daemon/scheduler.ts`)

Wraps the `croner` library. Maintains a `Map<pipelineId, Cron>` of active jobs. `restoreSchedules()` loads all active pipelines from the file store and schedules each. `schedulePipeline(pipeline)` creates a new `Cron` job for the pipeline's `scheduleCron` expression. `protect: true` prevents overlapping runs of the same cron. When the cron fires, it marks the pipeline `running`, invokes the pipeline execution callback, and marks `failed` if the callback throws. `cancelPipeline(id)` stops and removes the job. `stopAll()` is called on graceful shutdown.

### Management Agent

A headless invocation of `runDaemonAgent()` with `agentType: 'management'`. Its system prompt instructs it to work through five steps: discover upcoming events (90-day horizon), check existing pipelines, create new pipelines for uncovered events (with tested scripts), clean up stale pipelines, and write thesis notes for holdings that lack them. It has access to financial search, web search, all profile and thesis tools, all pipeline CRUD tools, and the code execution sandbox (`write_script`, `test_script`). It is explicitly prohibited from using `send_alert` or `send_reply`. Maximum 15 LLM iterations per run.

### Processing Agent

A headless invocation of `runDaemonAgent()` with `agentType: 'processing'`. Triggered by a `pipeline_complete` event. Its system prompt instructs it to: (1) read the ticker thesis and market context, (2) read all collected data files, (3) compare actuals to estimates and prior quarters, (4) make a binary ALERT/NO_ACTION decision, (5) if ALERT send via `send_alert` with specific numbers and a recommendation, (6) always call `append_thesis_entry` and `log_action`. Alert sensitivity is calibrated by risk tolerance embedded in the prompt. The agent defaults to NO_ACTION — it must have a positive reason to alert.

### Reactive Agent

A headless invocation of `runDaemonAgent()` with `agentType: 'reactive'`. Triggered by an inbound `message` event. Has the broadest tool set: all profile tools (including update), all thesis tools, pipeline creation and cancellation, `send_reply`, `write_script`, `test_script`, `run_script`, `read_collected_data`, financial search, web search, SEC filings, and the skill runner. Its system prompt emphasizes using the profile context to give personalized, specific answers. Runs concurrently in the daemon so it never blocks scheduled pipeline work.

### Financial Profile Store (`src/daemon/profile.ts`)

Pure JSON file I/O. `loadProfile()` reads `~/.dexter/profile.json` and returns null if absent (never throws). `saveProfile()` writes with 2-space JSON indentation and updates `updatedAt`. `addHolding()` upserts by ticker (removes from watchlist if promoted to held). `removeHolding()` filters out the ticker. `buildProfileContext()` renders the profile as a markdown string for injection into agent system prompts. All functions are async; always reads from disk to ensure agents see updates made mid-run.

### Pipeline Store (`src/daemon/pipelines.ts`)

JSON file I/O with one file per pipeline at `~/.dexter/pipelines/{id}.json`. Pipeline IDs are `{TICKER}-{eventType}-{timestamp}`. `getActivePipelines()` returns all pipelines with status `scheduled` or `running`. `findExistingPipeline()` enables the management agent to check for duplicates before creating a new pipeline. `createPipeline()` generates the ID, sets status to `scheduled`, and writes to disk. The canonical `outputDataPath` is stored in the pipeline definition at creation time so the processing agent always reads from the correct location without recomputing it.

### Thesis Memory Store (`src/daemon/memory.ts`)

JSON file I/O with one file per ticker at `~/.dexter/memory/{TICKER}-thesis.json`. Thesis history is append-only. `appendActionLog()` trims to the last 500 entries. `formatThesisForContext()` renders the last 5 history entries as a markdown block for injection into the processing agent's context — full history stays on disk.

### Code Execution Sandbox (`src/tools/code/execute-script.ts`)

The `runScript()` function spawns a Bun subprocess with `['bun', 'run', '--smol', scriptPath]`. The `--smol` flag minimizes memory usage. The environment is explicitly constructed from a safe allowlist (`buildSafeEnv()`): only `HOME`, `PATH`, `FINANCIAL_DATASETS_API_KEY`, search API keys, and the three `DEXTER_*` path variables are passed. No LLM API keys are forwarded. stdout and stderr are collected as `ArrayBuffer` and decoded after process exit. `MAX_OUTPUT_BYTES = 50,000` enforced by slicing. `read_collected_data` validates that the requested path is within `getCollectedDataDir()` before reading.

### Telegram Channel (`src/gateway/channels/telegram/plugin.ts`)

A singleton `TelegramChannel` wrapping `grammy.Bot`. `start()` launches long-polling in a non-blocking background promise. `onInbound()` registers a handler that fires for every `message:text` update. The daemon validates that `msg.chatId` matches the configured `authorizedChatId` before routing to the reactive agent — messages from unknown senders are silently dropped. `sendWithRetry()` retries up to 3 times on HTTP 429 with linear backoff. `formatForTelegram()` converts `**bold**` to HTML `<b>bold</b>` for Telegram HTML parse mode.

### Tool Registry (`src/daemon/tools.ts`)

`getDaemonTools({ agentType, scheduler })` returns the correct `StructuredToolInterface[]` for each agent type. Critically, the `scheduler` reference is passed through to `makeCreatePipelineTool(scheduler)`, a factory function that closes over the scheduler instance so newly created pipelines are immediately registered with `SchedulerEngine.schedulePipeline()` without requiring a daemon restart.

---

## Data Model

### FinancialProfile (`~/.dexter/profile.json`)

```typescript
interface FinancialProfile {
  name: string;
  timezone: string;
  currency: string;
  riskTolerance: 'conservative' | 'moderate' | 'moderate-aggressive' | 'aggressive';
  timeHorizon: string;
  investmentPhilosophy?: string;
  taxSituation?: string;
  goals: FinancialGoal[];
  holdings: Holding[];
  cash: number;
  watchlist: string[];
  constraints: PortfolioConstraints;
  delivery: {
    channel: 'telegram' | 'whatsapp';
    chatId: string;
    timezone: string;
    briefingCron?: string;
  };
  createdAt: string;
  updatedAt: string;
}

interface Holding {
  ticker: string;
  shares: number;
  costBasis: number;       // per share
  account: 'taxable' | 'IRA' | 'Roth IRA' | '401k' | 'other';
  notes?: string;
}
```

### Pipeline (`~/.dexter/pipelines/{id}.json`)

```typescript
interface Pipeline {
  id: string;             // "AAPL-earnings-1746748800000"
  ticker: string;
  eventType: EventType;
  description: string;    // "AAPL Q2 2026 Earnings"
  eventDate: string;      // "2026-05-01"

  collection: {
    scriptPath: string;
    scheduleCron: string;  // "0 21 1 5 *"
    outputDataPath: string; // canonical output dir, stored at creation time
    testedAt?: string;
    testResult?: 'success' | 'failure';
    lastRunAt?: string;
  };

  processing: {
    model?: string;
    notifyChannel: 'telegram' | 'whatsapp';
    alertThreshold?: string;
  };

  context: {
    position?: { shares: number; costBasis: number };
    thesis?: string;
    additionalContext?: string;
  };

  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  collectedDataPath?: string;
}
```

### TickerThesis (`~/.dexter/memory/{TICKER}-thesis.json`)

```typescript
interface TickerThesis {
  ticker: string;
  thesis: string;
  keyMetricsToWatch: string[];
  alertThresholds: string;    // natural language condition
  history: ThesisEntry[];
  openQuestions: string[];
  updatedAt: string;
}

interface ThesisEntry {
  date: string;
  event: string;
  note: string;
  decision: 'no_action' | 'add' | 'trim' | 'exit' | 'watch';
}
```

### ActionLogEntry (`~/.dexter/memory/action-log.json` — array, max 500)

```typescript
interface ActionLogEntry {
  date: string;
  ticker: string;
  event: string;
  decision: string;
  rationale: string;
  outcome?: string;    // filled retrospectively
}
```

### Collected Data (`~/.dexter/collected/{TICKER}/{eventType}/{period}/`)

No schema is enforced. The management agent writes scripts that produce arbitrary JSON files. The processing agent reads these files directly via `read_collected_data`. The canonical output path for a pipeline is stored in `pipeline.collection.outputDataPath` at creation time.

Convention established by the earnings template:
```
~/.dexter/collected/AAPL/earnings/AAPL Q1 2026 Earnings/
  transcript.json         # earnings call transcript
  income-statements.json  # quarterly income statements (last 5)
  estimates.json          # analyst revenue/EPS estimates
  metrics.json            # key financial metrics
```

---

## Failure Modes and Recovery

### Script Times Out or Crashes

**Detection:** Non-zero exit code or 120s kill timeout fires in `onPipelineFired()`.
**Recovery:** Pipeline set to `failed`. Does not auto-retry. On the next management run, the agent can investigate, rewrite, and reschedule. Future P1: send a low-priority admin alert when a pipeline fails.

### LLM API Call Fails

**Detection:** `callLlm()` uses retry with exponential backoff (3 attempts).
**Recovery:** Error propagates to event loop's try/catch; daemon logs and resumes. Failed event is dropped (not re-queued). Management runs retry on the next daily cycle.

### Daemon Process Crashes

**Detection:** External process supervisor (systemd, PM2) detects exit.
**Recovery:** Scheduler restores all active pipelines from disk on `start()` via `SchedulerEngine.restoreSchedules()`. Pipelines marked `running` at crash time are stuck — future P1: startup check resets `running` pipelines older than 10 minutes back to `scheduled`.

### Telegram Delivery Fails

**Detection:** `sendWithRetry()` throws after 3 retries.
**Recovery:** Error logged; alert logged to stdout and action log. Future P1: write failed alerts to a local queue file and retry on next daemon cycle.

### Profile File Corrupted

**Detection:** `loadProfile()` catches `JSON.parse` errors.
**Recovery:** `safeLoadProfile()` catches errors and falls back to cached profile, preventing the daemon from entering an infinite error loop.

### Data Not Written by Collection Script

**Detection:** `verifyDataWritten(dirPath)` checks for non-empty files after script exits 0.
**Recovery:** Pipeline marked `failed` without queuing processing. Prevents the processing agent from running against empty input and producing a hallucinated analysis.

---

## Security Model

| Layer | Mechanism |
|---|---|
| Script environment | Stripped allowlist — only `HOME`, `PATH`, read-only data API keys forwarded |
| Script filesystem | CWD set to `~/.dexter`; no OS-level isolation in current implementation |
| Data reads | `read_collected_data` validates path is within `getCollectedDataDir()` |
| Telegram inbound | Only messages from configured `authorizedChatId` are processed |
| WhatsApp inbound | Allowlist + self-chat mode; pairing code challenge for unknowns |
| Subprocess timeout | 30s for test runs, 120s for production pipeline runs |
| Stdout cap | 50KB max to prevent memory exhaustion |

**Known limitations (P1 backlog):**
- `HOME` in sandbox env grants access to `~/.ssh`, `~/.aws`, and all credential stores
- Scripts have full filesystem read access — only prevented by convention, not enforcement
- Fix: separate OS user, `chroot`, or container bind-mounting only `~/.dexter/collected/`

---

## Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime | Bun | Project standard; native TypeScript; fast subprocess spawning; Bun.spawn API |
| Agent framework | LangChain (JS) | Already in use; provides DynamicStructuredTool, tool execution, multi-provider LLM |
| Cron scheduler | croner | Bun-compatible; `protect: true` prevents overlapping runs; correct timezone handling |
| Telegram client | grammy | TypeScript-native; long-polling (no webhook server needed); handles rate limits |
| WhatsApp client | @whiskeysockets/baileys | Only viable open-source WhatsApp Web API client; already integrated |
| File store | JSON files | No database dependency; human-readable; sufficient for single-user use |
| LLM provider | OpenAI (default), Anthropic, Google, xAI, Ollama | Provider-agnostic by model name prefix; daemon model via `DEXTER_DAEMON_MODEL` env var |
| Financial data | financialdatasets.ai | Already integrated; earnings transcripts, filings, fundamentals in one API |
| Web search | Exa (preferred), Tavily (fallback) | Already integrated; Exa is higher quality for financial content |
| Script sandbox | Env variable restriction + subprocess | Pragmatic for current scale; OS-level hardening is P1 |

---

## Key Source Files

| File | Purpose |
|---|---|
| `src/daemon/daemon.ts` | Main daemon loop, WakeQueue, event dispatch, pipeline execution |
| `src/daemon/scheduler.ts` | croner-based cron engine |
| `src/daemon/pipelines.ts` | Pipeline store (CRUD + query) |
| `src/daemon/profile.ts` | Financial profile schema and storage |
| `src/daemon/memory.ts` | Thesis memory and action log |
| `src/daemon/prompts.ts` | System prompts for each agent role |
| `src/daemon/tools.ts` | Tool registries per agent role |
| `src/daemon/agent-runner.ts` | Headless agent execution |
| `src/daemon/setup.ts` | Interactive setup wizard |
| `src/daemon/index.ts` | Daemon entry point (start/setup/status) |
| `src/tools/code/execute-script.ts` | write_script, test_script, run_script, read_collected_data |
| `src/tools/daemon/pipeline-tools.ts` | create_pipeline factory + list/cancel/check tools |
| `src/tools/daemon/alert-tools.ts` | send_alert, send_reply |
| `src/tools/daemon/profile-tools.ts` | Profile read/write tools |
| `src/tools/daemon/memory-tools.ts` | Thesis and action log tools |
| `src/gateway/channels/telegram/plugin.ts` | grammy-based Telegram integration |
| `src/daemon/script-templates/earnings-collect.ts` | Reference collection script |

---

## Deployment

### Local / VPS

```
~/.dexter/
├── profile.json
├── pipelines/
├── memory/
├── scripts/
├── collected/
└── credentials/whatsapp/
```

Recommended: systemd or PM2 as process supervisor for auto-restart on crash.

```ini
# /etc/systemd/system/dexter.service
[Unit]
Description=Dexter Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/user/dexter
ExecStart=/usr/local/bin/bun run src/daemon/index.ts
Restart=always
RestartSec=10
EnvironmentFile=/home/user/dexter/.env

[Install]
WantedBy=multi-user.target
```

### Required Environment Variables

```bash
ANTHROPIC_API_KEY=sk-ant-...          # or OPENAI_API_KEY
DEXTER_DAEMON_MODEL=claude-sonnet-4-6 # defaults to gpt-4o if unset
TELEGRAM_BOT_TOKEN=...                # from @BotFather
FINANCIAL_DATASETS_API_KEY=...        # for earnings/financials data
EXASEARCH_API_KEY=...                 # optional: Exa web search
TAVILY_API_KEY=...                    # optional: Tavily web search
```
