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
  - Correlation IDs to tie a single pipeline run's logs together across interleaved events

- [ ] **Health endpoint / status command**
  - `bun run daemon:status` should show: active pipelines, last management run, uptime
  - Optional: HTTP health endpoint on localhost for monitoring
  - Dead man's switch: alert user via Telegram if the daemon process hasn't heartbeated in N hours

- [ ] **Pipeline cleanup for accumulated state**
  - Management agent should cancel pipelines for events more than 30 days past
  - Collected data files older than 90 days can be deleted or archived
  - Thesis history: enforce max 500 entries on disk (trim oldest), not just in context window
  - Files in `~/.dexter/pipelines/` and `~/.dexter/scripts/` are never cleaned up today

- [ ] **OS-level sandbox hardening**
  - Current env-stripping is correct but insufficient: scripts still have full filesystem access
  - `HOME` in the sandbox env grants access to `~/.ssh`, `~/.aws`, and all credential stores
  - Ideal: separate OS user, `bun --allow-write=~/.dexter/collected`, or seccomp filter
  - Track: https://bun.sh/docs/runtime/security

- [ ] **Atomic file writes for all state**
  - `profile.ts`, `memory.ts`, `pipelines.ts` all use read-modify-write without file locks
  - Write to a temp file then `rename()` to make writes atomic and crash-safe
  - Prevents silent data loss if two agents write the same file concurrently

- [ ] **Pipeline crash recovery**
  - Pipelines stuck in `running` state at startup should be reset to `scheduled` (with a restart counter) rather than left running or silently skipped
  - Check for partial output files from a crashed collection run before queuing processing

- [ ] **Failed pipeline user notification**
  - When a collection script fails (non-zero exit), send a brief Telegram notice
  - Currently fails silently — user never knows the earnings night collection broke

- [ ] **Processing agent structured output**
  - Enforce `{ decision: 'ALERT' | 'NO_ACTION', rationale: string, alert?: string }` via Zod on the agent's final message
  - Prevents the agent from neither alerting nor logging (silent max-iteration failure)
  - Use `withStructuredOutput` from LangChain or a final tool call gate

- [ ] **Management agent duplicate pipeline guard**
  - Normalize description strings before `check_pipeline_exists` (lowercase, strip punctuation)
  - Or use ticker+eventType+eventDate as the dedup key instead of free-form description
  - Idempotent startup: track `lastManagementRunDate` in daemon state; skip full run if already ran today

- [ ] **WhatsApp delivery warning**
  - Setup wizard should warn: "WhatsApp delivery is currently a stub — alerts will not be delivered"
  - Or block WhatsApp selection in setup until the gateway is live

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

- [ ] **Profile staleness during long agent runs**
  - System prompt receives profile at agent start; `read_profile` tool returns live disk state
  - If management agent modifies the profile mid-run, its system prompt context goes stale
  - Fix: remove profile from system prompt; always use `read_profile` tool for current data

- [ ] **Financial advice disclaimer system**
  - Reactive agent produces specific buy/sell recommendations with no regulatory disclaimer
  - Add a configurable disclaimer footer to all outbound alerts and reactive replies
  - Consider a capability flag to soften recommendations to "considerations" for non-professional users

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
