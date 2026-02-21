# Dexter — Execution Plan

## Current State (as of 2026-02-21)

The core daemon infrastructure is in place:
- Financial profile schema and storage (`src/daemon/profile.ts`)
- Thesis memory system (`src/daemon/memory.ts`)
- Pipeline store with full CRUD (`src/daemon/pipelines.ts`)
- croner-based scheduler (`src/daemon/scheduler.ts`)
- Daemon event loop with WakeQueue (`src/daemon/daemon.ts`)
- Three-role agent prompts (`src/daemon/prompts.ts`)
- Tool registries per agent role (`src/daemon/tools.ts`)
- Script sandbox: write, test, run (`src/tools/code/execute-script.ts`)
- Pipeline management tools (`src/tools/daemon/pipeline-tools.ts`)
- Alert delivery tools — Telegram live, WhatsApp stub (`src/tools/daemon/alert-tools.ts`)
- Telegram gateway via grammy (`src/gateway/channels/telegram/plugin.ts`)
- Interactive setup wizard (`src/daemon/setup.ts`)

---

## What Works Today

Run the daemon:
```bash
bun run daemon:setup   # interactive profile wizard
bun run daemon         # start the autonomous agent
```

The daemon will:
1. Load the financial profile
2. Start the management agent (discovers events, writes scripts, schedules pipelines)
3. Listen for Telegram messages (reactive agent)
4. Fire pipelines on schedule (collection → processing → alert gate)

---

## What's Missing / Next Steps

### P0 — Required for first end-to-end run

- [ ] **Event calendar integration** (`query_upcoming_events` tool)
  - Management agent needs a way to discover earnings dates, ex-div dates, analyst days
  - Options: Financial Datasets API `/earnings/calendar`, web search for SEC filings
  - File: `src/tools/daemon/event-tools.ts`

- [ ] **WhatsApp delivery** (replace stub in `alert-tools.ts`)
  - Current: `console.log` placeholder
  - Solution: Wire into existing `@whiskeysockets/baileys` WhatsApp session

- [ ] **Daemon entry point wired end-to-end**
  - `src/daemon/index.ts` exists but needs `ANTHROPIC_API_KEY` and tool registry wired
  - Confirm `agent-runner.ts` calls `runDaemonAgent` with correct LLM config

### P1 — Quality and reliability

- [ ] **Structured logging**
  - Replace `console.log` throughout daemon with levelled logger (`debug/info/warn/error`)
  - Persist logs to `~/.dexter/logs/daemon.log` with rotation

- [ ] **Health endpoint / status command**
  - `bun run daemon:status` should show: active pipelines, last management run, uptime
  - Optional: HTTP health endpoint on localhost for monitoring

- [ ] **Pipeline cleanup for accumulated state**
  - Management agent should cancel pipelines for events more than 30 days past
  - Prevent unbounded growth of `~/.dexter/pipelines/`

- [ ] **OS-level sandbox hardening**
  - Current sandbox strips env vars (good) but doesn't restrict filesystem access
  - Ideal: run scripts via `bun --allow-write=~/.dexter/collected` or similar flag
  - Track: https://bun.sh/docs/runtime/security

### P2 — Enhanced capabilities

- [ ] **Management agent: SEC EDGAR integration**
  - Fallback when transcript API returns 404 (data not yet published)
  - Fetch 10-Q/10-K directly from `data.sec.gov`

- [ ] **Processing agent: web search for analyst reactions**
  - After earnings, collect same-day analyst notes and price target changes
  - Adds market context beyond just the raw filing

- [ ] **Telegram: inline reply buttons**
  - On ALERT: add [Dismiss] [Snooze 1wk] [Show Full Analysis] buttons
  - Reduces friction for the user to acknowledge or defer alerts

- [ ] **Portfolio drift monitoring**
  - Daily check: if any position has drifted >5% from target allocation, alert
  - Doesn't require an earnings event — just profile data

- [ ] **Retrospective learning**
  - After each recommendation, track what actually happened
  - Monthly review: "Here's what I recommended vs what the market did"

---

## Running in Production

### Environment variables required

```bash
ANTHROPIC_API_KEY=sk-ant-...          # LLM for all agent reasoning
DEXTER_DAEMON_MODEL=claude-sonnet-4-6 # Model ID (defaults to gpt-4o if unset)
TELEGRAM_BOT_TOKEN=...                # From @BotFather
FINANCIAL_DATASETS_API_KEY=...        # For earnings/financials data
EXASEARCH_API_KEY=...                 # Optional: Exa web search
TAVILY_API_KEY=...                    # Optional: Tavily web search
```

### Systemd service (example)

```ini
[Unit]
Description=Dexter Autonomous Wealth Agent
After=network.target

[Service]
Type=simple
User=alex
WorkingDirectory=/home/alex/dexter
ExecStart=/usr/local/bin/bun run /home/alex/dexter/src/daemon/index.ts
Restart=on-failure
RestartSec=30
EnvironmentFile=/home/alex/.dexter/.env

[Install]
WantedBy=multi-user.target
```

---

## Architecture Decision Log

| Decision | Rationale |
|---|---|
| Bun for scripts | Fast startup, built-in TypeScript, Bun.write, fetch — ideal for short-lived data collection |
| croner for scheduling | Zero dependencies, Bun-compatible, handles timezone, prevents overlapping runs |
| grammy for Telegram | Type-safe, designed for modern TypeScript, active maintenance |
| JSON pipeline store | No database dependency; human-readable; `~/.dexter/` is the source of truth |
| Binary alert decision | Forces the processing agent to commit to a recommendation, not summarize |
| Three separate agent roles | Different tools, different prompts, different risk profiles — avoids capability confusion |
| `makeCreatePipelineTool(scheduler)` factory | Avoids global singleton; wires new pipelines into live scheduler without restart |
| `outputDataPath` in pipeline definition | Collection script and processing agent always agree on where data lives |

---

## Definition of Done (MVP)

The MVP is complete when this sentence is true:

> A user sets up their profile with AAPL as a holding, runs `bun run daemon`, and 6 weeks later receives a Telegram message analyzing AAPL's earnings against their investment thesis — with no further input from them.

Every feature and fix should be evaluated against this standard: does it enable or accelerate this scenario?
