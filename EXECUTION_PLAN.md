# Dexter Daemon — Execution Plan

**Version:** 1.0
**Date:** 2026-02-21
**Status:** Active
**Sprint length:** 1 week each

---

## MVP Definition

The smallest version of Dexter Daemon that proves the concept and is worth putting in front of real users is:

> A daemon that, given a profile with at least one holding and Telegram configured, can (1) discover that holding's next earnings date, (2) write and test a collection script for it, (3) schedule it, (4) run the script when the date arrives, (5) analyze the results, and (6) send an alert to Telegram with specific numbers and a recommendation — all without any user intervention after initial setup.

**MVP scope is bounded to:**
- Single user, single holding (can generalize once the loop works)
- Telegram only (WhatsApp delivery is P1)
- Earnings event type only (other event types follow the same pattern)
- Local file storage (no database, no hosting)
- Management + Processing + Reactive agents (all three are required for the core loop)

**MVP is NOT:**
- Multi-user
- WhatsApp delivery
- Morning briefing
- Portfolio drift alerts
- Backtesting

**Proof criteria for MVP:**
1. Engineer runs `bun run daemon:setup` and completes wizard in under 5 minutes
2. Daemon starts, triggers management run, management agent creates a pipeline for an upcoming earnings event with a tested script
3. Pipeline fires on schedule; processing agent receives data; alert arrives in Telegram with specific numbers and a recommendation

---

## Current State Assessment (as of 2026-02-21)

The following components exist and are code-complete based on the repository:

| Component | Status | Notes |
|-----------|--------|-------|
| Setup wizard | DONE | `src/daemon/setup.ts` — complete interactive wizard |
| Financial profile store | DONE | `src/daemon/profile.ts` — full CRUD |
| Thesis memory store | DONE | `src/daemon/memory.ts` — full CRUD |
| Pipeline store | DONE | `src/daemon/pipelines.ts` — full CRUD |
| Scheduler engine | DONE | `src/daemon/scheduler.ts` — croner wrapper |
| Daemon event loop | DONE | `src/daemon/daemon.ts` — wake queue + event router |
| Management agent prompts | DONE | `src/daemon/prompts.ts` |
| Processing agent prompts | DONE | `src/daemon/prompts.ts` |
| Reactive agent prompts | DONE | `src/daemon/prompts.ts` |
| Daemon agent runner | DONE | `src/daemon/agent-runner.ts` |
| Tool registry | DONE | `src/daemon/tools.ts` |
| Code execution sandbox | DONE | `src/tools/code/execute-script.ts` |
| Pipeline tools | DONE | `src/tools/daemon/pipeline-tools.ts` |
| Memory tools | DONE | `src/tools/daemon/memory-tools.ts` |
| Profile tools | DONE | `src/tools/daemon/profile-tools.ts` |
| Alert tools (Telegram) | DONE | `src/tools/daemon/alert-tools.ts` |
| Telegram channel | DONE | `src/gateway/channels/telegram/plugin.ts` |
| WhatsApp channel | DONE | `src/gateway/channels/whatsapp/` |
| Alert tools (WhatsApp) | PARTIAL | `deliverMessage()` logs to console for WA; no actual send |
| Daemon entry point | DONE | `src/daemon/index.ts` — start/setup/status commands |
| Earnings collection template | DONE | `src/daemon/script-templates/earnings-collect.ts` |
| Financial data tools | DONE | All finance tools in `src/tools/finance/` |
| Web search tools | DONE | Exa + Tavily in `src/tools/search/` |
| WhatsApp access control | DONE | `src/gateway/access-control.ts` — full access control |

**Gaps identified (work remaining):**

| Gap | Priority | Estimated Effort |
|-----|----------|-----------------|
| Scheduler not notified when `create_pipeline` tool runs — pipelines created during a run are never scheduled without a restart | P0 BUG | 1 day |
| Inbound Telegram `chatId` not validated against profile — any user who finds the bot can wake the reactive agent | P0 SECURITY | 0.5 days |
| WhatsApp alert delivery incomplete — `deliverMessage()` logs to console only | P1 | 0.5 days |
| Profile JSON corruption recovery — `loadProfile()` throws on parse error instead of returning null | P1 | 0.5 days |
| Stuck `running` pipelines never reset after a crash | P1 | 0.5 days |
| File permissions not set after profile save (should be 0o600) | P1 | 0.25 days |
| `daemon:status` does not show next scheduled run time per pipeline | P1 | 0.25 days |
| End-to-end integration test covering full pipeline lifecycle | P0 TESTING | 2 days |
| Process supervisor documentation (systemd unit, PM2 config) | P1 DOCS | 0.5 days |
| Morning briefing cron not implemented in daemon | P1 | 1 day |
| Failed alert delivery not persisted for retry | P1 | 0.5 days |

---

## Sprint 1 — Reliability and Integration (Week 1)

**Goal:** Every component works correctly end-to-end. A real user can set up, start, and see the first management run complete successfully with pipelines actually scheduled in the running engine.

### Tasks

**S1-1 (P0 BUG): Fix scheduler threading in `create_pipeline` tool**

Problem: When the management agent calls `create_pipeline`, the new pipeline is saved to disk but is not registered with the running `SchedulerEngine`. The daemon only restores schedules on startup. Any pipeline created during a management run is never executed until the next daemon restart.

Fix: Pass the `SchedulerEngine` reference into `getDaemonTools()` for the management agent context. In `createPipelineTool.func`, after `createPipeline(def)` resolves, call `scheduler.schedulePipeline(pipeline)` if the scheduler reference is present.

Files: `src/daemon/tools.ts`, `src/tools/daemon/pipeline-tools.ts`

Test: Start daemon, trigger management run via startup event, verify new pipeline appears in `scheduler.jobs` map without restarting the daemon process.

---

**S1-2 (P0 SECURITY): Validate inbound chatId against profile**

Problem: Any Telegram user who discovers the bot token can send messages and wake the reactive agent. The reactive agent then runs with the actual user's portfolio context visible.

Fix: In the `onInbound` handler in `daemon.ts`, load the profile and compare `msg.from` (Telegram chat ID as a string) against `profile.delivery.chatId`. Reject messages from non-matching senders with a generic "unauthorized" response that does not reveal any portfolio data.

Files: `src/daemon/daemon.ts`

Test: Send a message from an unknown Telegram chat ID to the bot. Verify the bot returns a generic response and does not enqueue a `message` event or wake the reactive agent.

---

**S1-3 (P1): Complete WhatsApp alert delivery**

Problem: `deliverMessage()` in `alert-tools.ts` only calls `console.log()` for the WhatsApp case. No actual message is sent.

Fix: Import the WhatsApp channel from the gateway and call its `send()` method. Mirror the Telegram implementation structure including error handling.

Files: `src/tools/daemon/alert-tools.ts`, `src/gateway/channels/whatsapp/plugin.ts`

Test: Configure a test WhatsApp session, trigger a processing agent run with collected test data, verify the alert message arrives on WhatsApp.

---

**S1-4 (P1): Profile corruption recovery**

Problem: If `profile.json` is partially written during a crash, `JSON.parse` throws and the error propagates. The daemon then behaves unpredictably depending on where in startup the failure occurs.

Fix: Wrap `JSON.parse` in `loadProfile()` with a try/catch block. On parse failure, log the path and a recovery hint ("profile.json is corrupted — restore from profile.json.bak or run daemon:setup"), then return null. Before every `saveProfile()` call, write a backup to `profile.json.bak`.

Files: `src/daemon/profile.ts`

Test: Write syntactically invalid JSON to `~/.dexter/profile.json`. Run `bun run daemon:status`. Verify the output is a human-readable error with recovery instructions rather than a stack trace.

---

**S1-5 (P1): Startup health check for stuck pipelines**

Problem: If the daemon crashes while a pipeline is in `running` state, that pipeline is permanently stuck. `getActivePipelines()` returns it (status is `running`), `restoreSchedules()` schedules it, but when the cron fires again it may behave incorrectly depending on whether the collection script left partial output.

Fix: In `WealthAgentDaemon.start()`, after `restoreSchedules()`, load all pipelines and find any where `status === 'running'` and `lastRunAt` is more than 10 minutes in the past. Reset those to `scheduled` status. Log each reset with the pipeline ID.

Files: `src/daemon/daemon.ts`

Test: Manually set a pipeline's status to `running` and `lastRunAt` to an hour ago in its JSON file. Start the daemon. Verify the pipeline is reset to `scheduled` and appears in the active scheduler jobs.

---

**S1-6 (P0 TESTING): End-to-end integration test for the pipeline lifecycle**

Write a test that covers the complete flow from management run to alert delivery without live LLM or network calls. Use a pre-recorded LLM response fixture that mimics the management agent calling `write_script`, `test_script`, and `create_pipeline` in sequence, and the processing agent calling `send_alert`.

Test steps:
1. Create a minimal test profile (one holding: AAPL) in a temp directory
2. Initialize a `SchedulerEngine` with a mock callback
3. Simulate a management agent run using a mocked `runDaemonAgent` that returns a fixture sequence of tool calls
4. Verify the pipeline was saved to disk with status `scheduled`
5. Verify the pipeline was registered in the `SchedulerEngine.jobs` map (the S1-1 fix)
6. Invoke the pipeline fire callback directly (bypassing cron timing)
7. Verify a `pipeline_complete` event was added to the wake queue
8. Simulate a processing agent run that calls `send_alert`
9. Verify `send_alert` was called with a message containing the expected ticker and urgency

Files: `src/daemon/daemon.test.ts` (new), `src/daemon/pipeline-lifecycle.test.ts` (new)

---

**S1-7 (P1 DOCS): Process supervisor configuration**

Write `docs/DEPLOYMENT.md` covering:
- systemd unit file for Linux (copy-paste ready)
- PM2 `ecosystem.config.js` for macOS/cross-platform
- Recommended VPS specifications
- How to verify the daemon is running
- How to view daemon logs

---

**Sprint 1 Exit Criteria:**
- `bun run daemon:setup` completes without error on a clean install
- `bun run daemon` starts, triggers management run, creates a pipeline, and that pipeline is immediately scheduled in the running SchedulerEngine — all confirmed by logs, no restart required
- Inbound Telegram messages from an unrecognized `chatId` are rejected with a generic response
- Integration test passes in CI: full pipeline lifecycle from management through alert delivery

---

## Sprint 2 — Quality and User Experience (Week 2)

**Goal:** The processing agent produces high-quality, specific alerts. The management agent handles edge cases. Setup and status UX is polished enough for external users.

### Tasks

**S2-1 (P1): Management agent quality improvements**

- Ensure management agent cancels pipelines for: (a) event dates that have already passed, (b) tickers no longer in the portfolio or watchlist
- Add handling for `failed` pipelines: management agent should inspect the failure, attempt to rewrite the script, retest, and reschedule
- Enforce the 90-day forward-looking window: management agent should not create pipelines for events beyond 90 days (too speculative)

Files: `src/daemon/prompts.ts`

---

**S2-2 (P1): Processing agent alert format**

Restructure the alert format to be consistent and scannable on a mobile screen. Every alert must include all five elements: what happened with exact numbers, how it compares to estimates, how it affects the thesis, a specific recommendation (action, quantity, rationale), and the next catalyst to watch.

Enforce this in the `send_alert` tool schema by splitting the `message` field into structured subfields. Render them into a clean Telegram message via `formatForTelegram()`.

New `send_alert` schema:

```typescript
{
  headline: string;       // "AAPL Q2 Miss: Services +11.2% vs +14.8% est"
  specifics: string;      // key metric values with vs-estimate deltas
  thesisImpact: string;   // how this changes the investment thesis
  recommendation: string; // "Trim 15-20% (suggest selling 20 shares)"
  nextCatalyst: string;   // "WWDC June 9"
  urgency: 'low' | 'medium' | 'high';
  ticker: string;
}
```

Files: `src/tools/daemon/alert-tools.ts`, `src/gateway/channels/telegram/plugin.ts`, `src/daemon/prompts.ts`

---

**S2-3 (P1): Morning briefing implementation**

Add `briefing_run` as a fifth wake event type. If `profile.delivery.briefingCron` is set, schedule a cron job in `WealthAgentDaemon.start()` that pushes a `briefing_run` event. Handle `briefing_run` in `handleEvent()` by invoking the reactive agent with a briefing-specific query that asks for: upcoming events this week for portfolio holdings, current portfolio P&L summary, any open thesis questions or alerts from the past week.

Files: `src/daemon/daemon.ts`, `src/daemon/prompts.ts`

---

**S2-4 (P1): Improve `daemon:status` output**

Current `daemon:status` shows pipeline status strings but not the next scheduled run time. Add:
- Next run time for each active pipeline (from `SchedulerEngine.getNextRun()`)
- Thesis coverage: list which holdings have thesis notes and which do not
- Telegram connection status (configured / not configured)
- Last management run timestamp (read from a small state file written after each management run)

Files: `src/daemon/index.ts`

---

**S2-5 (P1): File permission hardening**

After `saveProfile()`, call `fs.chmod(getProfilePath(), 0o600)`. After writing WhatsApp credentials directory, call `fs.chmod(credentialsDir, 0o700)`. Document the expected permissions in `docs/DEPLOYMENT.md`.

Files: `src/daemon/profile.ts`

---

**S2-6 (P1): Alert delivery failure persistence**

When `send_alert` exhausts all retries without success, write the failed alert to `~/.dexter/alerts-failed.jsonl` as a newline-delimited JSON entry with timestamp, channel, chatId, and full message. On daemon startup, before the first management run, check for entries in `alerts-failed.jsonl` and attempt re-delivery. Remove successfully re-delivered entries.

Files: `src/tools/daemon/alert-tools.ts`, `src/daemon/daemon.ts`

---

**S2-7: Reactive agent response quality review**

Walk through five representative user queries against the reactive agent with a real profile and verify response quality:
1. "How are my holdings doing?" — should reference specific tickers, actual cost bases, actual P&L
2. "I bought 20 shares of GOOGL at $175" — should call `add_holding`, confirm, mention it will start monitoring
3. "What earnings do I have coming up?" — should list pipelines from the store with dates
4. "Should I be worried about NVDA?" — should read thesis and recent action log before answering
5. "Cancel the MSFT earnings pipeline" — should call `cancel_pipeline`, confirm

Document any quality failures as issues for prompt improvements.

---

**Sprint 2 Exit Criteria:**
- Every processing agent alert contains all five required elements (headline, specifics, thesis impact, recommendation, next catalyst)
- Management agent correctly cancels stale and orphaned pipelines in a simulated test scenario
- Morning briefing fires on the configured cron and sends a coherent portfolio summary via Telegram
- `daemon:status` shows next run time and thesis coverage
- Failed alerts are written to disk and retried on the next daemon startup

---

## Sprint 3 — Robustness and Coverage (Week 3)

**Goal:** All event types work. The system handles real-world API messiness. Test coverage is production-grade. Documentation is complete.

### Tasks

**S3-1: Collection script template library**

Write and manually test reference collection scripts for each event type. These become the default patterns the management agent can customize rather than generating from scratch each time.

Scripts to write and verify:
- `templates/ex-dividend-collect.ts` — fetches ex-dividend date and dividend amount; writes `dividend-info.json`
- `templates/filing-10q-collect.ts` — fetches 10-Q via SEC filings API; extracts MD&A (Part 1, Item 2) and financial statements; writes `mda.json` and `financials.json`
- `templates/filing-8k-collect.ts` — fetches most recent 8-K; extracts all items; writes `8k-items.json`
- `templates/price-alert-collect.ts` — fetches current price snapshot; compares to threshold from env var `ALERT_THRESHOLD_PRICE`; writes `price-check.json`

Each template must: handle API errors with retry, write output only to `DEXTER_COLLECTED_DIR`, exit 0 on success (even if some data is unavailable), exit 1 on fatal failure.

Files: `src/daemon/script-templates/` (new files)

---

**S3-2: Market context weekly update**

Add a condition to the management agent prompt: if `market-context.json` is absent or `updatedAt` is more than 7 days ago, use web search to fetch a current macro summary and call `save_market_context` before proceeding with the rest of the management cycle. The management agent should prioritize this step on Monday runs.

Files: `src/daemon/prompts.ts`

---

**S3-3: Portfolio drift detection**

In the management agent, after event discovery, compute approximate current portfolio value for each holding by fetching the latest price snapshot. If any position exceeds `constraints.maxPositionPct`, add a note in the management run summary and optionally send a low-urgency alert via the processing agent pathway. Do not trigger this on the first management run for a new profile (baseline is not yet established).

Files: `src/daemon/prompts.ts`, possible new tool in `src/tools/daemon/`

---

**S3-4: Structured daemon logging**

Add structured logging to `~/.dexter/daemon.log` using newline-delimited JSON. Each log entry includes: timestamp, level, component, message, and optional structured data. Log rotation: when the file exceeds 10MB, rename to `daemon.log.1` (overwriting any previous backup) and start a fresh `daemon.log`.

Log these events at minimum:
- Daemon start and stop
- Management run start, end, summary (pipelines created/cancelled)
- Pipeline fire and completion
- Alert sent (ticker, urgency, channel)
- Alert delivery failure
- Agent errors

Files: `src/utils/daemon-logger.ts` (new), `src/daemon/daemon.ts`, `src/daemon/agent-runner.ts`

---

**S3-5: Configuration preflight check on startup**

Before entering the event loop, run a preflight check and print a clear summary:

```
[daemon] Preflight check:
  Profile:          FOUND (Alex, 5 holdings)
  Telegram:         CONFIGURED (bot token set)
  LLM provider:     OPENAI (gpt-5.2)
  Financial data:   CONFIGURED (FINANCIAL_DATASETS_API_KEY set)
  Web search:       CONFIGURED (Exa)
  Active pipelines: 3 scheduled

[daemon] All checks passed. Starting event loop.
```

Fail loudly (non-zero exit) only if no LLM provider key is available. Warn (but continue) for missing financial data API key and missing Telegram token.

Files: `src/daemon/daemon.ts`

---

**S3-6: Test suite expansion**

Target: >80% line coverage on `src/daemon/` directory. Add unit tests for:

- `SchedulerEngine`: `restoreSchedules()` with mock pipeline store, `schedulePipeline()` cron creation, `cancelPipeline()` job removal, `stopAll()` cleanup
- `WakeQueue`: `push()` unblocks a waiting `next()`, multiple events drain in order, `length` reflects queue state
- `profile.ts`: `buildProfileContext()` format, `addHolding()` deduplication and watchlist removal, `removeHolding()` filter, parse error returns null
- `pipelines.ts`: `findExistingPipeline()` with all status combinations, `getActivePipelines()` filter correctness
- `memory.ts`: `formatThesisForContext()` output format, `appendActionLog()` 500-entry cap enforcement
- `alert-tools.ts`: urgency prefix selection, `formatForTelegram()` header stripping and bold conversion

Framework: Bun test runner (`bun test`). All tests must run without network or LLM API calls.

---

**S3-7: User documentation**

Write `docs/DAEMON.md` covering:

1. What Dexter Daemon is and is not
2. Setup walkthrough (step by step from zero)
3. How to read `daemon:status`
4. How pipelines work (lifecycle, how to inspect, how to cancel)
5. How to customize alert thresholds (editing thesis JSON)
6. How to add/remove positions (via Telegram message or editing profile JSON)
7. How to debug a failed pipeline (reading scripts dir, collected dir, daemon log)
8. FAQ: Why didn't I get an alert? / How do I make alerts more/less sensitive? / What does the daemon cost to run? (LLM API costs estimate)

Update `README.md` to add a "Daemon Mode" section with a brief description and a link to `docs/DAEMON.md`.

---

**Sprint 3 Exit Criteria:**
- All event types have tested, runnable collection script templates
- Market context updates automatically without user action
- Test coverage on `src/daemon/` directory is above 80%
- `docs/DAEMON.md` is complete, accurate, and reviewed
- Structured logging works and `daemon.log` is written correctly

---

## Sprint 4 — Production Readiness and Launch (Week 4)

**Goal:** The daemon is ready for external users. It has been validated on a real portfolio through at least one real event. The launch checklist is fully green.

### Tasks

**S4-1: Live integration test on a real portfolio**

Deploy the daemon on a VPS with a real profile containing at least AAPL and NVDA as holdings. Run for a minimum of 72 hours continuously. Verify:
- At least one management run completes and creates pipelines with tested scripts
- `daemon:status` shows correct pipeline and thesis information
- Telegram alerts can be triggered (use collected historical earnings data to simulate a pipeline completion if no live event is available during the test window)
- Daemon survives a simulated crash (kill -9) and restores correctly on restart

Document all issues found. P0 issues block launch. P1 issues are scheduled for the next sprint.

---

**S4-2: Dogfood period — internal users**

3 to 5 internal users run the daemon on their real portfolios for one week. Collect structured feedback on:
- Setup experience: where did people get stuck?
- Alert quality: were alerts specific enough? Were there false positives?
- Missing coverage: what events did the daemon miss that users expected it to catch?
- Reactive agent quality: did it correctly reference their specific positions?
- Daemon stability: any unexpected crashes or hung pipelines?

File a GitHub issue for every reported problem. Triage to P0/P1/P2 before launch.

---

**S4-3: Security review**

Audit the following specific points:

1. `buildSafeEnv()` in `execute-script.ts` — confirm the environment variable allowlist contains no LLM API keys, no bot tokens, and no credentials paths
2. Telegram `chatId` validation in `daemon.ts` — confirm that the validation runs before any profile data is accessed
3. WhatsApp access control in `access-control.ts` — confirm self-chat mode blocks all non-self senders, allowlist mode is correctly enforced
4. File permissions — verify that `profile.json` is written with 0o600 permissions
5. `.gitignore` — verify that `.dexter/` is fully gitignored including all subdirectories

Document findings. Any finding that creates a realistic attack vector is P0 and blocks launch.

---

**S4-4: LLM cost profiling**

Measure actual LLM token usage for a typical day of daemon operation:
- Management agent run (10-holding portfolio, 3 new pipelines to create)
- Processing agent run (earnings event, ALERT decision)
- Reactive agent run (a portfolio status question)
- Morning briefing run

Calculate daily cost at current OpenAI gpt-5.2 pricing. Document in `docs/DAEMON.md` under "What does it cost to run?". If daily cost exceeds $2 for a typical user, identify the most expensive operations and investigate whether a smaller model (e.g. gpt-4o-mini for the management agent's event discovery step) can reduce costs without quality loss.

---

**S4-5: Release preparation**

- Bump version in `package.json` to the appropriate CalVer date (`2026.X.Y`)
- Write the `CHANGELOG.md` entry for Daemon v1.0 covering all features added since the pre-daemon baseline
- Create the git tag: `git tag v2026.X.Y && git push origin v2026.X.Y`
- Create a GitHub Release with:
  - Summary of what Daemon Mode is
  - Prerequisites list (API keys needed)
  - Quick start (3 commands: install, setup, run)
  - Link to `docs/DAEMON.md` for full documentation

---

**Sprint 4 Exit Criteria — Full Launch Checklist:**

```
SETUP AND STARTUP
[ ] bun run daemon:setup completes in under 5 minutes on a clean install
[ ] bun run daemon starts without errors when all required env vars are present
[ ] bun run daemon:status shows correct profile, pipeline, and thesis coverage information
[ ] Daemon startup preflight check prints a clear summary of configured components

CORE PIPELINE LOOP
[ ] Management agent creates at least one pipeline on a fresh profile with one holding
[ ] New pipeline is scheduled in the running SchedulerEngine without a daemon restart (S1-1 fix verified)
[ ] Pipeline fires on cron schedule and collection script runs to completion
[ ] Processing agent sends a Telegram alert with the required five-element format
[ ] Alert urgency prefixes render correctly in Telegram (info / warning / critical)

RELIABILITY
[ ] Daemon survives kill -9 and restores all pipeline schedules correctly on restart
[ ] Pipelines stuck in "running" status are reset to "scheduled" on startup
[ ] LLM API errors are caught and logged without crashing the daemon event loop
[ ] Collection script timeout (120s) is enforced; failed pipelines are marked as failed

SECURITY
[ ] Telegram messages from unknown chatIds receive a generic response only — no portfolio data exposed
[ ] Collection script subprocess environment contains no LLM API keys or bot tokens
[ ] profile.json is written with 0o600 file permissions
[ ] .gitignore covers all files under .dexter/

ALERT DELIVERY
[ ] Alert delivery retries up to 3 times on Telegram HTTP 429
[ ] Failed alerts after all retries are written to alerts-failed.jsonl
[ ] Failed alerts are re-delivered on next daemon startup

REACTIVE AGENT
[ ] Responds to portfolio questions with specific position data (ticker, shares, cost basis, P&L)
[ ] Correctly calls add_holding when user says "I bought X shares of TICKER at $PRICE"
[ ] Correctly calls remove_holding when user says "I sold all my TICKER"
[ ] Responds to unknown users with a generic message without revealing profile data

TESTING AND QUALITY
[ ] bun test passes with no failures
[ ] bun run typecheck passes with no errors
[ ] Test coverage on src/daemon/ is above 80%
[ ] Security audit complete with no open P0 findings

DOCUMENTATION
[ ] docs/DAEMON.md is complete and reviewed by at least one person who was not the author
[ ] README.md has a "Daemon Mode" section linking to docs/DAEMON.md
[ ] docs/DEPLOYMENT.md has copy-paste ready systemd unit and PM2 config

VALIDATION
[ ] Daemon ran continuously for 72 hours on a VPS without a manual restart
[ ] At least 3 internal users ran the daemon for 7+ days with no P0 bugs reported
[ ] LLM cost per user per day is estimated and documented
[ ] At least one real Telegram alert was received with a rating of "actionable" from the recipient

POST-LAUNCH (30-day check)
[ ] 10+ external users running daemon
[ ] Average 8+ active pipelines per user
[ ] Zero reports of unauthorized access via Telegram or WhatsApp
[ ] Fewer than 5 reports of daemon crashes requiring manual intervention
[ ] First batch of P2 features scoped based on user feedback
```

---

## Dependencies Between Components

```
Setup Wizard
  |
  v
Financial Profile Store  <---------+
  |                                |
  v                                |
Management Agent                   |
  |                                |
  +-- writes --> Thesis Memory     |
  |                                |
  +-- creates --> Pipeline Store   |
                      |            |
                      v            |
              Scheduler Engine     |
                      |            |
                      v            |
          Collection Script (subprocess)
                      |
                      v
              Processing Agent  --> Alert Delivery --> Telegram / WhatsApp
                      |
                      +-- writes --> Thesis Memory
                      +-- writes --> Action Log

Reactive Agent (triggered by inbound message)
  |-- reads --> Financial Profile Store
  |-- reads --> Thesis Memory
  |-- reads --> Action Log
  |-- calls --> add_holding / remove_holding (Financial Profile Store)
  |-- calls --> create_pipeline (Pipeline Store + Scheduler Engine)
  +-- calls --> send_reply (Telegram / WhatsApp)

Code Execution Sandbox
  |-- used by Management Agent (write_script + test_script)
  +-- used by Reactive Agent (write_script + run_script for ad-hoc calculations)

Telegram Channel (singleton)
  |-- inbound messages --> WakeQueue (message event)
  +-- outbound alerts <-- Alert Delivery Tool

Financial Data Layer (shared)
  |-- used by Management Agent (event discovery, financial context)
  |-- used by Processing Agent (fresh data to supplement collected files)
  +-- used by Reactive Agent (answer portfolio questions)
```

**Critical path to MVP:**

Setup Wizard -> Profile Store -> Management Agent -> Pipeline Store -> Code Sandbox -> Scheduler Engine -> Collection Script -> Processing Agent -> Alert Delivery -> Telegram

The single most important unresolved issue before real monitoring is possible is **S1-1**: pipelines created by the management agent during a run are not scheduled in the live `SchedulerEngine`. This must be fixed first.

---

## Testing Strategy

### Layer 1: Unit Tests (all sprints, always run in CI)

Target: Pure functions and data transformations. Zero network calls, zero LLM calls, zero file system dependencies (use tmp directories where needed).

Priority targets:
- `profile.ts`: `buildProfileContext()` rendering, `addHolding()` upsert and watchlist deduplication, `removeHolding()` filter, parse error handling
- `pipelines.ts`: `findExistingPipeline()` with every status variant, `getActivePipelines()` filter
- `memory.ts`: `formatThesisForContext()` output format, `appendActionLog()` 500-entry cap
- `scheduler.ts`: schedule, cancel, restore, stopAll with mocked croner
- `daemon.ts`: `WakeQueue` async push/next behavior, multiple events in order
- `alert-tools.ts`: urgency prefix selection, `formatForTelegram()` transformation

### Layer 2: Integration Tests (Sprints 1–2, run in CI with mocked externals)

Target: Agent tool execution flows. LLM calls are mocked with pre-recorded tool call sequences. Network calls are mocked. File I/O uses a temp directory.

Priority flows:
- Management run: fixture tool call sequence creates a pipeline, verifies pipeline on disk and in scheduler
- Processing run: fixture tool call sequence reads collected data and calls send_alert, verifies alert delivery was invoked with correct parameters
- Reactive profile update: fixture for "I bought TSLA at $280", verifies add_holding was called and profile was updated

Mocking strategy: Intercept `callLlm()` with a fixture map keyed on agent type and iteration number. Return pre-constructed tool call sequences. This tests the orchestration layer completely without LLM costs.

### Layer 3: End-to-End Tests (Sprint 3, run manually before launch)

Target: Real LLM, real financial data API, sandboxed output under a temp `.dexter/` directory.

Required scenarios before launch:
1. Management agent on a 5-holding profile: verify it discovers earnings events and creates pipelines with scripts that pass `test_script`
2. Processing agent on pre-collected AAPL earnings data from a historical quarter: verify ALERT or NO_ACTION decision is reasonable and contains specific numbers
3. Reactive agent on "how is my portfolio doing" with a profile containing 3 holdings: verify response references all tickers with correct cost bases

These tests require real API keys and will not run in automated CI. They are run manually before each sprint 4 release gate.

### Layer 4: Dogfooding (Sprint 4)

3–5 internal users run the daemon on real portfolios for a minimum of 7 days. Each user tracks:
- Number of alerts received
- Rating for each alert (1 = useless noise, 5 = exactly what I needed)
- Any events they expected an alert for but did not receive
- Any daemon restarts they had to perform manually

Aggregate results: target average alert rating >= 4.0, zero required manual restarts per user per week.

### CI Configuration

The existing CI workflow (`.github/workflows/ci.yml`) runs `bun run typecheck` and `bun test` on every push and PR. Layer 1 and Layer 2 tests are added to `bun test`. All tests at these layers must complete in under 60 seconds total and require no external API keys. External API keys are never stored in CI secrets for automated test runs.
