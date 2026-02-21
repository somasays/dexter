# Dexter — Architecture Reference

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     DEXTER DAEMON                                     │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  MANAGEMENT AGENT  (runs daily)                              │    │
│  │                                                              │    │
│  │  1. Read financial profile                                   │    │
│  │  2. Scan event calendar for all holdings + watchlist         │    │
│  │  3. For each upcoming event → check if pipeline exists       │    │
│  │  4. If not → write collection script + test it              │    │
│  │  5. Schedule pipeline (trigger → collect → process → gate)   │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                            │                                          │
│                  ┌─────────▼──────────┐                              │
│                  │  PIPELINE STORE     │                              │
│                  │  ~/.dexter/pipelines│                              │
│                  └─────────┬──────────┘                              │
│                            │  (triggers at scheduled time)           │
│  ┌─────────────────────────▼────────────────────────────────────┐   │
│  │  PIPELINE RUNNER                                              │   │
│  │                                                               │   │
│  │  COLLECT: runs user-written Bun script in subprocess          │   │
│  │     → earnings transcript, 10-Q, price data, news            │   │
│  │     → stores raw output in ~/.dexter/collected/               │   │
│  │                                                               │   │
│  │  PROCESS: agent wakes, reads data, compares to thesis         │   │
│  │     → evaluates: revenue, margins, guidance vs expectations   │   │
│  │                                                               │   │
│  │  GATE: decide if user needs to know                           │   │
│  │     → if action needed: send Telegram alert                  │   │
│  │     → if not: update notes, sleep                            │   │
│  └───────────────────────────────────────────────────────────────┘   │
│                            │                                          │
│                            ▼                                          │
│            User's Telegram (only when it matters)                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The Three Agent Roles

### 1. Management Agent (daily)

**Trigger:** Every morning at 06:00, or on daemon startup, or when profile changes.

**Responsibilities:**
- Reads the full financial profile
- Queries the event calendar for all holdings and watchlist items
- For each upcoming event: checks if a monitoring pipeline exists
- If not: writes a collection script, tests it, fixes any issues, then schedules the pipeline
- Reviews existing pipelines — marks stale or broken ones as cancelled

**System prompt framing:**
> "You manage a portfolio for [name]. Ensure nothing important is missed.
> For each holding and watchlist item, identify all upcoming events that could affect the investment thesis.
> For each event, either confirm a pipeline exists or create one.
> You can write and test collection scripts, schedule pipeline runs, and update thesis memory."

**Tools available:** `read_profile`, `write_script`, `test_script`, `create_pipeline`, `list_pipelines`,
`check_pipeline_exists`, `cancel_pipeline`, `mark_pipeline_tested`, `read_thesis`, `financial_search`, `web_search`

---

### 2. Collection Script (scheduled subprocess)

**Trigger:** At the cron time the management agent scheduled.

**What it is:** A Bun TypeScript script written and tested by the management agent, stored at `~/.dexter/scripts/`.

**What it does:** Collects raw data (transcript, filing, price data) and writes it to `~/.dexter/collected/{TICKER}/{eventType}/{period}/`.

**Security model:**
- Runs in a child process with a stripped environment (no API keys except read-only data APIs)
- No access to LLM APIs or credentials
- Configurable timeout (default 30s) and stdout size limit (50KB)
- File writes restricted to `~/.dexter/` output directories

**Example pattern:**
```typescript
const OUTPUT_DIR = join(process.env.DEXTER_COLLECTED_DIR!, TICKER, 'earnings', PERIOD);
await mkdir(OUTPUT_DIR, { recursive: true });
const res = await fetch(API_URL, { headers: { 'X-API-KEY': process.env.FINANCIAL_DATASETS_API_KEY! } });
await writeFile(join(OUTPUT_DIR, 'transcript.json'), JSON.stringify(await res.json()));
console.log('COLLECTED: transcript');
```

---

### 3. Processing Agent (event-triggered)

**Trigger:** After a collection script completes successfully and data is verified.

**Responsibilities:**
- Reads the collected data from `pipeline.collection.outputDataPath`
- Reads the investment thesis for the ticker
- Reads current position details from profile
- Analyzes: revenue vs estimate, margin trend, guidance vs consensus, management tone
- Makes a **binary decision: ALERT or NO_ACTION**

**System prompt framing:**
> "You are processing [TICKER]'s [event] for [name].
> [name] owns [N] shares at cost basis $[X]. Target allocation: [Y]%.
> Thesis: [thesis from memory].
> Analyze the collected data. Does this change the investment thesis?
> If yes, or if action is recommended: compose a clear, specific alert.
> If no: update the thesis notes and return NO_ACTION."

**Tools available:** `read_profile`, `read_thesis`, `append_thesis_entry`, `read_collected_data`,
`send_alert`, `log_action`, `financial_search`, `web_search`

---

## Data Layout

```
~/.dexter/
├── profile.json              # Financial profile (portfolio, goals, risk tolerance)
├── pipelines/                # Pipeline definitions (one JSON file per pipeline)
│   ├── AAPL-earnings-1740000000000.json
│   └── NVDA-earnings-1740000000001.json
├── scripts/                  # Agent-written collection scripts
│   ├── AAPL-earnings-2026-Q1-collect.ts
│   └── NVDA-earnings-2026-Q2-collect.ts
├── collected/                # Raw collected data (organized by ticker/event/period)
│   ├── AAPL/
│   │   └── earnings/
│   │       └── AAPL Q1 2026 Earnings/
│   │           ├── transcript.json
│   │           ├── income-statements.json
│   │           └── estimates.json
│   └── NVDA/
├── memory/                   # Agent's working notes
│   ├── AAPL-thesis.json      # Investment thesis + decision history
│   ├── NVDA-thesis.json
│   ├── market-context.md     # Current macro context
│   └── action-log.md         # Log of all past decisions
└── output/                   # Scratch output for ad-hoc scripts
```

---

## Pipeline Definition

```jsonc
// ~/.dexter/pipelines/AAPL-earnings-1740000000000.json
{
  "id": "AAPL-earnings-1740000000000",
  "ticker": "AAPL",
  "eventType": "earnings",
  "description": "AAPL Q1 2026 Earnings",
  "eventDate": "2026-04-30",
  "status": "scheduled",

  "collection": {
    "scriptPath": "~/.dexter/scripts/AAPL-earnings-2026-Q1-collect.ts",
    "scheduleCron": "0 21 30 4 *",
    "outputDataPath": "~/.dexter/collected/AAPL/earnings/AAPL Q1 2026 Earnings",
    "testedAt": "2026-02-21T10:30:00Z",
    "testResult": "success"
  },

  "processing": {
    "notifyChannel": "telegram",
    "alertThreshold": "revenue_miss_gt_3pct OR guidance_cut OR services_growth_below_10pct"
  },

  "context": {
    "position": { "shares": 100, "costBasis": 165.00 },
    "thesis": "Services revenue growth + capital returns. Hold through volatility."
  }
}
```

---

## Daemon Event Loop

The daemon runs as a long-lived process with a wake event queue:

```
WakeEvent types:
  - scheduled_tick    (cron fired, run management agent or pipeline)
  - pipeline_complete (collection script succeeded, queue processing)
  - telegram_message  (user sent a message, run reactive agent)
  - startup           (daemon just started)
```

**Key invariant:** Management and processing agents run serially through the event queue. Reactive agent (responding to user messages) runs concurrently so it never blocks scheduled work.

---

## Security Model

| Layer | Mechanism |
|---|---|
| Script environment | Stripped env — only `HOME`, `PATH`, and read-only data API keys |
| Script filesystem | CWD set to `~/.dexter`; no access outside |
| Data reads | `read_collected_data` validates path is within `~/.dexter/collected/` |
| Telegram inbound | Only messages from the configured `telegramChatId` are processed |
| Subprocess timeout | 30s default (60s for production runs) |
| Stdout cap | 50KB max to prevent memory exhaustion |

---

## Key Source Files

| File | Purpose |
|---|---|
| `src/daemon/daemon.ts` | Main daemon loop, WakeQueue, event dispatch |
| `src/daemon/scheduler.ts` | croner-based cron engine |
| `src/daemon/pipelines.ts` | Pipeline store (CRUD + query) |
| `src/daemon/profile.ts` | Financial profile schema and storage |
| `src/daemon/memory.ts` | Thesis memory and action log |
| `src/daemon/prompts.ts` | System prompts for each agent role |
| `src/daemon/tools.ts` | Tool registries per agent role |
| `src/daemon/agent-runner.ts` | Headless agent execution |
| `src/tools/code/execute-script.ts` | write_script, test_script, run_script, read_collected_data |
| `src/tools/daemon/pipeline-tools.ts` | create_pipeline, list_pipelines, etc. |
| `src/tools/daemon/alert-tools.ts` | send_alert, send_reply |
| `src/gateway/channels/telegram/plugin.ts` | grammy-based Telegram integration |
