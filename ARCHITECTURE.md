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

## Data Flow Diagram

```
                      +----------------------------------------------------------+
                      |               DEXTER DAEMON PROCESS                     |
                      |                                                          |
  +----------+  msg   |  +----------------+   push event   +------------------+ |
  | Telegram |------->|  | TelegramChannel|--------------->|                  | |
  |  (user)  |<-------|  |   (grammy)     |                |    WakeQueue     | |
  +----------+  reply |  +----------------+                |   (async FIFO)   | |
                      |                                    |                  | |
  +----------+  msg   |  +----------------+   push event   |                  | |
  | WhatsApp |------->|  | WhatsAppChannel|--------------->|                  | |
  |  (user)  |<-------|  | (baileys)      |                |                  | |
  +----------+  reply |  +----------------+                |                  | |
                      |                                    |                  | |
                      |  +----------------+   push event   |                  | |
                      |  |   Cron Jobs    |--------------->|                  | |
                      |  |  (croner)      |                +--------+---------+ |
                      |  | - daily mgmt   |                         |           |
                      |  | - pipelines    |                         | next()    |
                      |  +----------------+                         v           |
                      |                                  +--------------------+ |
                      |                                  |   Event Router     | |
                      |                                  |   handleEvent()    | |
                      |                                  +--------+-----------+ |
                      |                                           |             |
                      |              +----------------------------+----------+  |
                      |              |                            |          |  |
                      |              v                            v          v  |
                      |  +-----------------+  +------------------+  +----------+ |
                      |  | Management      |  | Processing       |  | Reactive | |
                      |  | Agent           |  | Agent            |  | Agent    | |
                      |  |                 |  |                  |  |          | |
                      |  | Tools:          |  | Tools:           |  | Tools:   | |
                      |  | - profile R/W   |  | - profile R      |  | - profile| |
                      |  | - thesis R/W    |  | - thesis R/W     |  |   R/W    | |
                      |  | - pipeline CRUD |  | - read_collected |  | - thesis | |
                      |  | - write_script  |  | - send_alert     |  |   R/W    | |
                      |  | - test_script   |  | - fin. search    |  | - pipeln | |
                      |  | - fin. search   |  | - web search     |  | - scripts| |
                      |  | - web search    |  | - log_action     |  | - reply  | |
                      |  +-----------------+  +------------------+  +----------+ |
                      +----------------------------------------------------------+
                                    |                |               |
          +-------------------------+----------------+---------------+----------+
          |                        SHARED INFRASTRUCTURE                       |
          |                                                                     |
          |  +-----------------+  +---------------+  +-------------+  +------+ |
          |  | Financial       |  | Web Search    |  | ~/.dexter/  |  | Code | |
          |  | Datasets API    |  | Exa / Tavily  |  | File Store  |  | Sand | |
          |  | (financials,    |  |               |  | profile.json|  | box  | |
          |  |  filings,       |  |               |  | pipelines/  |  |      | |
          |  |  transcripts)   |  |               |  | memory/     |  | 30s  | |
          |  +-----------------+  +---------------+  | scripts/    |  | tmout| |
          |                                          | collected/  |  | 50KB | |
          |  +-----------------+  +---------------+  +-------------+  +------+ |
          |  | LLM Providers   |  | Telegram Bot  |                           |
          |  | OpenAI / Claude |  | API (grammy)  |                           |
          |  | Google / xAI /  |  |               |                           |
          |  | Ollama          |  |               |                           |
          |  +-----------------+  +---------------+                           |
          +--------------------------------------------------------------------+
```

---

## Component Responsibilities

### WealthAgentDaemon (`src/daemon/daemon.ts`)

The process root. It initializes the SchedulerEngine, the TelegramChannel singleton, and the WakeQueue. On `start()`, it restores pipeline schedules from disk, connects Telegram polling, schedules the daily management cron (6am UTC), triggers an immediate startup management run, and enters `runEventLoop()`. The event loop blocks on `wakeQueue.next()` — a zero-CPU await that returns when a new event arrives. Each event is dispatched to the appropriate agent runner. Errors in the event loop are caught, logged, and do not kill the loop. `stop()` cancels all crons, stops Telegram polling, and exits cleanly.

### WakeQueue (`src/daemon/daemon.ts`)

A minimal async FIFO. Producers call `push(event)`; the event loop calls `await next()`. When the queue is empty, `next()` suspends via a `Promise` that is resolved by the next `push()`. This is the correct pattern for a zero-CPU event-driven daemon: no polling, no `setInterval`, no busy-wait.

### SchedulerEngine (`src/daemon/scheduler.ts`)

Wraps the `croner` library. Maintains a `Map<pipelineId, Cron>` of active jobs. `restoreSchedules()` loads all active pipelines from the file store and schedules each. `schedulePipeline(pipeline)` creates a new `Cron` job for the pipeline's `scheduleCron` expression. When the cron fires, it: (1) marks the pipeline `running` in the store, (2) invokes the pipeline execution callback in `WealthAgentDaemon`, and (3) marks `failed` if the callback throws. `cancelPipeline(id)` stops and removes the job. `stopAll()` is called on graceful shutdown.

### Management Agent

A headless invocation of `runDaemonAgent()` with `agentType: 'management'`. Its system prompt instructs it to work through five steps: discover upcoming events (90-day horizon), check existing pipelines, create new pipelines for uncovered events (with tested scripts), clean up stale pipelines, and write thesis notes for holdings that lack them. It has access to financial search, web search, all profile and thesis tools, all pipeline CRUD tools, and the code execution sandbox (`write_script`, `test_script`). It is explicitly prohibited from using `send_alert` or `send_reply`. Maximum 15 LLM iterations per run.

### Processing Agent

A headless invocation of `runDaemonAgent()` with `agentType: 'processing'`. Triggered by a `pipeline_complete` event. Its system prompt instructs it to: (1) read the ticker thesis and market context, (2) read all collected data files, (3) compare actuals to estimates and prior quarters, (4) make a binary ALERT/NO_ACTION decision, (5) if ALERT send via `send_alert` with specific numbers and a recommendation, (6) always call `append_thesis_entry` and `log_action`. Alert sensitivity is calibrated by risk tolerance embedded in the prompt. The agent defaults to NO_ACTION — it must have a positive reason to alert.

### Reactive Agent

A headless invocation of `runDaemonAgent()` with `agentType: 'reactive'`. Triggered by an inbound `message` event. Has the broadest tool set: all profile tools (including update), all thesis tools, pipeline creation and cancellation, `send_reply`, `write_script`, `test_script`, `run_script`, `read_collected_data`, financial search, web search, SEC filings, and the skill runner. Its system prompt emphasizes using the profile context to give personalized, specific answers. It is instructed to be concise (this is a messaging interface) and to proactively update the profile when the user mentions position changes.

### DaemonAgentRunner (`src/daemon/agent-runner.ts`)

The shared headless agent loop. Takes: query, systemPrompt, agentType, optional scheduler reference, optional replyTo (for reactive agent routing), optional model override. Gets the appropriate tools from `getDaemonTools()`. Creates an `AgentToolExecutor` with `DAEMON_PRE_APPROVED = new Set(['write_file', 'edit_file', 'write_script'])` — file writes are auto-approved in the headless context. Runs the standard iterative LLM loop: call LLM, check for tool calls, execute tools, manage context window (clear oldest tool results when above threshold), repeat until no tool calls or max iterations (default 15). Generates a final answer in a separate LLM call without tools bound.

### Financial Profile Store (`src/daemon/profile.ts`)

Pure JSON file I/O. `loadProfile()` reads `~/.dexter/profile.json` and returns null if absent (never throws). `saveProfile()` writes with 2-space JSON indentation and updates `updatedAt`. `addHolding()` upserts by ticker (removes from watchlist if promoted to held). `removeHolding()` filters out the ticker. `buildProfileContext()` renders the profile as a markdown string for injection into agent system prompts. All functions are async; no caching — always reads from disk to ensure the reactive agent sees updates made by the management agent in the same process.

### Pipeline Store (`src/daemon/pipelines.ts`)

JSON file I/O with one file per pipeline at `~/.dexter/pipelines/{id}.json`. Pipeline IDs are `{TICKER}-{eventType}-{timestamp}`. `getActivePipelines()` returns all pipelines with status `scheduled` or `running` — this is the input to `SchedulerEngine.restoreSchedules()`. `findExistingPipeline()` enables the management agent to check for duplicates before creating a new pipeline. `createPipeline()` generates the ID, sets status to `scheduled`, and writes to disk. The scheduler is notified separately by the management agent calling `createPipelineTool`, which must explicitly schedule the new pipeline via the `SchedulerEngine` reference passed through `getDaemonTools()`.

### Thesis Memory Store (`src/daemon/memory.ts`)

JSON file I/O with one file per ticker at `~/.dexter/memory/{TICKER}-thesis.json`. Thesis history is append-only (history array). `appendActionLog()` trims to the last 500 entries. `formatThesisForContext()` renders the last 5 history entries as a markdown block for injection into the processing agent's context. `saveMarketContext()` and `loadMarketContext()` manage the single market context file.

### Code Execution Sandbox (`src/tools/code/execute-script.ts`)

The `runScript()` function spawns a Bun subprocess with `['bun', 'run', '--smol', scriptPath]`. The `--smol` flag minimizes memory usage. The environment is explicitly constructed from a safe allowlist (`buildSafeEnv()`): only `HOME`, `PATH`, `FINANCIAL_DATASETS_API_KEY`, search API keys, and the three `DEXTER_*` path variables are passed. No LLM API keys, no `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`, no arbitrary `process.env` forwarding. stdout and stderr are collected as `ArrayBuffer` and decoded after process exit. `MAX_OUTPUT_BYTES = 50,000` enforced by slicing. `testScriptTool` checks an optional expected output pattern; `runScriptTool` is used for production execution via the reactive agent; pipeline production execution happens directly in `onPipelineFired()` in the daemon class.

### Telegram Channel (`src/gateway/channels/telegram/plugin.ts`)

A singleton `TelegramChannel` wrapping `grammy.Bot`. `start()` launches long-polling in a non-blocking background promise. `onInbound()` registers a handler that fires for every `message:text` update. The daemon registers its wake handler via `onInbound()`. `sendWithRetry()` retries up to 3 times on HTTP 429 with linear backoff (2s, 4s, 6s). `formatForTelegram()` strips markdown headers and converts `**bold**` to HTML `<b>bold</b>` for Telegram HTML parse mode. The singleton is accessed via `getTelegramChannel()` which creates the instance only if `TELEGRAM_BOT_TOKEN` is set; returns null otherwise. This is the key "no-op if not configured" pattern.

### Tool Registry (`src/daemon/tools.ts`)

`getDaemonTools({ agentType, scheduler })` returns the correct `StructuredToolInterface[]` for each agent type. Management tools include: profile read/write, thesis read/write, all pipeline CRUD (`create_pipeline`, `list_pipelines`, `check_pipeline_exists`, `cancel_pipeline`, `mark_pipeline_tested`), code execution (`write_script`, `test_script`), financial search, financial metrics, web search, web fetch, read filings, skill runner. Processing tools include: profile read, thesis read/write, action log append, read collected data, send alert, financial search, financial metrics, web search. Reactive tools include: all profile tools, all thesis tools, pipeline create/list/cancel, send reply, write script, test script, run script, read collected data, financial search, financial metrics, web search, web fetch, read filings, read file, skill runner. The `scheduler` reference (passed from the daemon to the management agent) allows the `create_pipeline` tool to immediately register the new pipeline with `SchedulerEngine.schedulePipeline()`.

---

## Data Model

### FinancialProfile (`~/.dexter/profile.json`)

```typescript
interface FinancialProfile {
  name: string;                    // "Alex"
  timezone: string;                // "America/New_York"
  currency: string;                // "USD"
  riskTolerance: 'conservative' | 'moderate' | 'moderate-aggressive' | 'aggressive';
  timeHorizon: string;             // "10-15 years"
  investmentPhilosophy?: string;   // "growth at reasonable price"
  taxSituation?: string;           // "long-term gains preferred, high bracket"
  goals: FinancialGoal[];
  holdings: Holding[];
  cash: number;
  watchlist: string[];             // ["TSLA", "META"]
  constraints: PortfolioConstraints;
  delivery: {
    channel: 'telegram' | 'whatsapp';
    chatId: string;                // Telegram chat ID or WhatsApp E.164 phone
    timezone: string;
    briefingCron?: string;         // "0 7 * * 1-5"
  };
  createdAt: string;               // ISO timestamp
  updatedAt: string;               // ISO timestamp
}

interface Holding {
  ticker: string;                  // "AAPL"
  shares: number;                  // 120
  costBasis: number;               // 178.50  (per share)
  account: 'taxable' | 'IRA' | 'Roth IRA' | '401k' | 'other';
  notes?: string;
}

interface FinancialGoal {
  id: string;                      // "retirement"
  description: string;             // "Retire by age 55"
  targetAmount: number;            // 2000000
  targetDate: string;              // "2038-01-01"
  priority: 'primary' | 'secondary';
  currentProgress?: number;        // current portfolio value toward this goal
}

interface PortfolioConstraints {
  avoidSectors?: string[];         // ["defense", "tobacco"]
  avoidTickers?: string[];         // ["MO"]
  maxPositionPct?: number;         // 25  (% of portfolio)
  rebalanceThreshold?: number;     // 0.05  (5% drift triggers review)
}
```

### Pipeline (`~/.dexter/pipelines/{id}.json`)

```typescript
interface Pipeline {
  id: string;             // "AAPL-earnings-1746748800000"
  ticker: string;         // "AAPL"
  eventType: EventType;   // "earnings"
  description: string;    // "AAPL Q2 2026 Earnings"
  eventDate: string;      // "2026-05-01"

  collection: {
    scriptPath: string;   // "/home/user/.dexter/scripts/AAPL-earnings-Q2-2026-collect.ts"
    scheduleCron: string; // "0 21 1 5 *"
    testedAt?: string;    // ISO timestamp of last successful test
    testResult?: 'success' | 'failure';
    lastRunAt?: string;   // ISO timestamp of last execution
  };

  processing: {
    model?: string;       // override model (default: DEXTER_DAEMON_MODEL env)
    notifyChannel: 'telegram' | 'whatsapp';
    alertThreshold?: string; // "revenue miss >3% OR guidance cut"
  };

  context: {
    position?: { shares: number; costBasis: number }; // snapshot at creation time
    thesis?: string;          // snapshot of thesis at creation time
    additionalContext?: string;
  };

  status: 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  collectedDataPath?: string; // "~/.dexter/collected/AAPL/earnings/Q2-2026/"
}

type EventType = 'earnings' | 'ex_dividend' | 'analyst_day' |
                 'filing_10k' | 'filing_10q' | 'filing_8k' |
                 'price_alert' | 'custom';
```

### TickerThesis (`~/.dexter/memory/{TICKER}-thesis.json`)

```typescript
interface TickerThesis {
  ticker: string;              // "AAPL"
  thesis: string;              // "Apple is a platform business... Services drives multiple expansion..."
  keyMetricsToWatch: string[]; // ["Services revenue YoY growth", "iPhone installed base"]
  alertThresholds: string;     // "services growth below 10% YoY OR gross margin below 43% OR guidance cut"
  history: ThesisEntry[];      // last N entries of analysis
  openQuestions: string[];     // ["Will Vision Pro reach meaningful volume by 2027?"]
  updatedAt: string;
}

interface ThesisEntry {
  date: string;      // ISO timestamp
  event: string;     // "Q1 2026 Earnings"
  note: string;      // "Services grew 14.2% YoY, above 12.8% estimate. iPhone units light but ASP strong..."
  decision: 'no_action' | 'add' | 'trim' | 'exit' | 'watch';
}
```

### ActionLogEntry (`~/.dexter/memory/action-log.json` — array, max 500)

```typescript
interface ActionLogEntry {
  date: string;       // ISO timestamp
  ticker: string;     // "NVDA"
  event: string;      // "Q4 2025 Earnings"
  decision: string;   // "ALERT sent: trim 20 shares, thesis intact but valuation stretched"
  rationale: string;  // "Revenue beat +8%, but guidance implies deceleration. P/E at 55x forward..."
  outcome?: string;   // filled retrospectively: "Price -12% next 2 weeks. Trim was correct."
}
```

### MarketContext (`~/.dexter/memory/market-context.json`)

```typescript
interface MarketContext {
  summary: string;        // "Fed on hold, inflation at 2.8%, equity markets near ATH..."
  keyThemes: string[];    // ["AI capex supercycle", "rate sensitivity", "election uncertainty"]
  sectorOutlooks?: Record<string, string>; // { "tech": "bullish - strong AI demand" }
  updatedAt: string;
}
```

### Collected Data (`~/.dexter/collected/{TICKER}/{eventType}/{period}/`)

No schema is enforced. The management agent writes scripts that produce arbitrary JSON files. The processing agent reads these files directly. The convention established by the earnings template is:

```
~/.dexter/collected/AAPL/earnings/Q2-2026/
  transcript.json         # earnings call transcript
  income-statements.json  # quarterly income statements (last 5)
  estimates.json          # analyst revenue/EPS estimates
  metrics.json            # key financial metrics
```

---

## Failure Modes and Recovery Strategies

### Failure 1: Collection Script Times Out or Crashes

**Scenario:** The agent-written script hangs (API rate limit, infinite loop) or exits non-zero.
**Detection:** `onPipelineFired()` in the daemon catches non-zero exit code; `runScript()` fires a kill signal after 120 seconds.
**Recovery:** `updatePipelineStatus(id, 'failed')`. The pipeline does not retry automatically. On the next management run, the management agent sees the `failed` status and can investigate (read the pipeline, check the script, rewrite and reschedule). No alert is sent for script failure — this is an infrastructure problem, not a user-facing event. Future P1: send a low-priority admin alert when a pipeline fails.

### Failure 2: LLM API Call Fails During Agent Run

**Scenario:** OpenAI/Anthropic returns a 500, 429, or connection timeout.
**Detection:** `callLlm()` uses `withRetry()` with exponential backoff (3 attempts, 500ms x 2^n).
**Recovery:** If all retries fail, the error propagates to `runDaemonAgent()`, which propagates to `handleEvent()`, which is caught by the event loop's try/catch. The daemon logs the error, sleeps 1 second, and resumes processing the next event. The failed event is dropped (not re-queued). Management runs retry on the next daily cycle. For processing: the pipeline is marked `completed` without an alert — worst case is a missed analysis, not a crash.

### Failure 3: Daemon Process Crashes

**Scenario:** An uncaught exception or OOM kills the daemon process.
**Detection:** External process supervisor (systemd, PM2) detects exit.
**Recovery:** The scheduler restores all active pipelines from disk on `start()` via `SchedulerEngine.restoreSchedules()`. Profile and thesis memory are fully on disk. Any in-flight agent run is lost; it will retry on the next scheduled event or management run. Pipelines marked `running` at crash time are stuck — the management agent should detect and reset them on its next run. Future P1: add a startup health check that resets `running` pipelines to `scheduled` if `lastRunAt` is more than 10 minutes ago.

### Failure 4: Telegram Delivery Fails

**Scenario:** Telegram Bot API returns an error (bot blocked, chat not found, network partition).
**Detection:** `sendWithRetry()` throws after 3 retries.
**Recovery:** Error is logged. The alert message is logged to stdout and the action log. The processing agent marks the event as analyzed in the thesis. The user misses the notification — future P1: write failed alert to a local queue file and retry on next daemon cycle.

### Failure 5: Profile File Corrupted or Missing

**Scenario:** `profile.json` is invalid JSON (partial write during crash).
**Detection:** `loadProfile()` will throw a `JSON.parse` error.
**Recovery:** Currently unhandled — the error propagates to the management and reactive agents which skip execution ("no profile found"). Future P1: `loadProfile()` should catch parse errors, log them with a recovery hint, and return null rather than throwing. A backup copy (`profile.json.bak`) should be written before every save.

### Failure 6: Duplicate Pipeline Creation

**Scenario:** Two management runs overlap (rare, but possible if first run takes over 24 hours).
**Detection:** `findExistingPipeline()` check in `check_pipeline_exists` tool.
**Recovery:** The management agent is instructed to call `check_pipeline_exists` before `create_pipeline`. The tool returns `exists: true` and the agent skips creation. The croner `protect: true` flag prevents the management cron from overlapping with itself. As a further safeguard, pipeline IDs include a timestamp — even if the duplicate check fails, the pipelines have different IDs and can be manually cleaned up.

### Failure 7: Collection Script Writes Outside the Sandbox

**Scenario:** A buggy or adversarially generated script tries to write to `~/` or `/tmp/`.
**Detection:** Not prevented at the OS level — only at the environment variable level.
**Recovery:** The script has no knowledge of other paths; `DEXTER_COLLECTED_DIR` is the only output path injected. Scripts using hardcoded paths would fail at runtime since they would have incorrect path assumptions. Future P1: run scripts in a `chroot` or container with `~/.dexter/` bind-mounted as the only writable path.

---

## Security Model

### Principle 1: Least-Privilege Script Execution

Collection scripts run in a subprocess with a surgically constructed environment. The allowlist is:

```
HOME, PATH, FINANCIAL_DATASETS_API_KEY, EXASEARCH_API_KEY, TAVILY_API_KEY,
DEXTER_SCRIPTS_DIR, DEXTER_COLLECTED_DIR, DEXTER_OUTPUT_DIR
```

LLM API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) are never forwarded. Telegram tokens are never forwarded. The script cannot make LLM calls, cannot discover the user's credentials, and cannot read the profile or thesis files. This is the primary security boundary.

### Principle 2: Tool-Gated Agent Capabilities

Each agent type receives a specific tool subset. The management agent cannot send alerts (no `send_alert` tool). The processing agent cannot create or cancel pipelines, cannot run scripts in production (no `run_script`). The reactive agent has the broadest access but still operates on behalf of a verified user (inbound message on the configured `chatId`). The tool boundary is enforced in `getDaemonTools()`, not in agent prompts.

### Principle 3: Fail-Closed Messaging Access

The Telegram channel only processes messages from the configured `chatId`. The daemon must validate that `event.from` matches the profile's `chatId` before routing to the reactive agent. WhatsApp uses an explicit allowlist plus self-chat mode. Unknown senders receive a pairing code challenge response. No unauthenticated user can execute agent actions.

### Principle 4: Credentials on Disk

- `~/.dexter/profile.json` contains `chatId` (Telegram chat ID or phone number) — not a secret but should not be world-readable. File permissions should be 0o600.
- `~/.dexter/credentials/whatsapp/` contains WhatsApp session data — sensitive. Directory should be 0o700.
- API keys are in `.env` in the project root (gitignored). Never stored in `~/.dexter/`.
- Profile does not store brokerage credentials, SSNs, or actual account balances from live data feeds.

### Principle 5: No Network Server

The daemon does not listen on any port. All communication is outbound (to APIs) or via Telegram/WhatsApp polling. There is no attack surface from the network. The threat model is local file access and key exposure.

---

## Technology Decisions and Rationale

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Runtime | Bun | Existing project uses Bun; first-class TypeScript without compilation step; fast subprocess spawning; native `Bun.spawn` API used in pipeline execution |
| Agent framework | LangChain (JS) | Already in use across the codebase; provides `DynamicStructuredTool`, tool execution abstraction, multi-provider LLM support |
| Cron scheduler | `croner` | Bun-compatible; `protect: true` prevents overlapping job runs; handles timezone correctly; supports standard cron expressions |
| Telegram client | `grammy` | TypeScript-native; active maintenance; long-polling (no webhook server needed for single-user deployment); handles rate limits with sensible errors |
| WhatsApp client | `@whiskeysockets/baileys` | The only viable open-source WhatsApp Web API client; session-based; already integrated in the existing gateway |
| File store | JSON files | No database dependency; human-readable; easy to inspect and debug; sufficient for single-user, single-daemon use case. Would need rethinking for multi-user P2 |
| LLM provider | OpenAI (default), Anthropic, Google, xAI, Ollama | Provider-agnostic; detected by model name prefix; daemon model configurable via `DEXTER_DAEMON_MODEL` env var; defaults to `gpt-5.2` |
| Financial data | `financialdatasets.ai` | Already integrated; provides earnings transcripts, filings, fundamentals, estimates, prices in one API; free tier includes AAPL, NVDA, MSFT |
| Web search | Exa (preferred), Tavily (fallback) | Already integrated; Exa is higher quality for financial content; falls back gracefully |
| Script sandboxing | Environment variable restriction + subprocess | Pragmatic for the current scale; more robust sandboxing (containers, seccomp) deferred to P1 |

---

## Deployment Model

### Single-User Local Deployment (Supported)

Run the daemon on a personal machine or home server:

```
~/.dexter/                      # all daemon state
+-- profile.json                # user financial profile
+-- pipelines/                  # one JSON per pipeline
|   +-- AAPL-earnings-*.json
|   +-- NVDA-earnings-*.json
+-- memory/                     # thesis and action log
|   +-- AAPL-thesis.json
|   +-- NVDA-thesis.json
|   +-- action-log.json
|   +-- market-context.json
+-- scripts/                    # agent-written collection scripts
|   +-- AAPL-earnings-Q2-2026-collect.ts
|   +-- NVDA-earnings-Q1-2026-collect.ts
+-- collected/                  # data written by collection scripts
|   +-- AAPL/earnings/Q2-2026/
|       +-- transcript.json
|       +-- income-statements.json
|       +-- estimates.json
+-- credentials/                # WhatsApp session (if used)
    +-- whatsapp/default/
```

**Process supervision:** Use `systemd` (Linux) or `pm2` (cross-platform) to restart on crash.

Example systemd unit:

```ini
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

### VPS / Cloud Deployment

Any Linux VPS with Bun installed and outbound HTTPS access. The daemon is a single process with no open ports. Recommended minimum: 1 vCPU, 512MB RAM, 10GB disk. Cost-effective options: Hetzner CAX11 (~4 EUR/month), DigitalOcean Basic Droplet (~6 USD/month).

### Environment Variables Required for Daemon

```env
# LLM (at least one required)
OPENAI_API_KEY=...            # default provider; daemon uses gpt-5.2 by default
ANTHROPIC_API_KEY=...         # optional; use claude-* model names

# Financial data
FINANCIAL_DATASETS_API_KEY=...  # required for collection scripts

# Web search (optional but recommended for management agent event discovery)
EXASEARCH_API_KEY=...         # preferred
TAVILY_API_KEY=...            # fallback

# Messaging (at least one required)
TELEGRAM_BOT_TOKEN=...        # required for Telegram alerts

# Daemon configuration
DEXTER_DAEMON_MODEL=gpt-5.2   # LLM for daemon agents (optional; defaults to gpt-5.2)

# Tracing (optional)
LANGSMITH_API_KEY=...
LANGSMITH_PROJECT=dexter-daemon
LANGSMITH_TRACING=true
```
