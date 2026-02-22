# Dexter Daemon — Execution Plan

**Version:** 1.0
**Date:** 2026-02-21
**Status:** Active — Sprint 1 partially complete

---

## MVP Definition

The smallest version of Dexter Daemon that proves the concept:

> A daemon that, given a profile with at least one holding and Telegram configured, can (1) discover that holding's next earnings date, (2) write and test a collection script for it, (3) schedule it, (4) run the script when the date arrives, (5) analyze the results, and (6) send an alert to Telegram with specific numbers and a recommendation — all without any user intervention after initial setup.

**MVP scope:** Single user, single holding, Telegram only, earnings event type, local file storage.

**Proof criteria for MVP:**
1. Engineer runs `bun run daemon:setup` and completes wizard in < 5 minutes
2. Daemon starts, triggers management run, management agent creates a pipeline for an upcoming earnings event with a tested script
3. Pipeline fires; processing agent receives data; alert arrives in Telegram with specific numbers

---

## Current State Assessment (as of 2026-02-21)

| Component | Status | Notes |
|---|---|---|
| Setup wizard | ✅ DONE | `src/daemon/setup.ts` |
| Financial profile store | ✅ DONE | `src/daemon/profile.ts` |
| Thesis memory store | ✅ DONE | `src/daemon/memory.ts` |
| Pipeline store | ✅ DONE | `src/daemon/pipelines.ts` |
| Scheduler engine | ✅ DONE | `src/daemon/scheduler.ts` |
| Daemon event loop | ✅ DONE | `src/daemon/daemon.ts` |
| Agent prompts (all 3) | ✅ DONE | `src/daemon/prompts.ts` |
| Daemon agent runner | ✅ DONE | `src/daemon/agent-runner.ts` |
| Tool registry | ✅ DONE | `src/daemon/tools.ts` |
| Code execution sandbox | ✅ DONE | `src/tools/code/execute-script.ts` |
| Pipeline tools | ✅ DONE | `src/tools/daemon/pipeline-tools.ts` |
| Memory tools | ✅ DONE | `src/tools/daemon/memory-tools.ts` |
| Profile tools | ✅ DONE | `src/tools/daemon/profile-tools.ts` |
| Alert tools (Telegram) | ✅ DONE | `src/tools/daemon/alert-tools.ts` |
| Telegram channel | ✅ DONE | `src/gateway/channels/telegram/plugin.ts` |
| WhatsApp channel | ✅ DONE | `src/gateway/channels/whatsapp/` |
| Alert tools (WhatsApp) | ⚠️ PARTIAL | `deliverMessage()` logs to console; no actual WA send |
| Daemon entry point | ✅ DONE | `src/daemon/index.ts` |
| Earnings collection template | ✅ DONE | `src/daemon/script-templates/earnings-collect.ts` |
| Financial data tools | ✅ DONE | All finance tools in `src/tools/finance/` |
| Web search tools | ✅ DONE | Exa + Tavily in `src/tools/search/` |

**Critical bugs fixed (PE review, 2026-02-21):**

| Bug | Fix Applied |
|---|---|
| `createPipelineTool` never wired into live scheduler | ✅ `makeCreatePipelineTool(scheduler)` factory pattern |
| Data path recomputed at processing time, risking mismatch | ✅ `outputDataPath` stored in pipeline definition at creation |
| WakeQueue race condition — rapid events could drop a resolver | ✅ `resolvers: Array<() => void>` + while-loop drain |
| Telegram accepts messages from any user | ✅ `chatId !== authorizedChatId` guard |
| Reactive agent blocked the event loop | ✅ Runs concurrently without await |
| `read_collected_data` allowed arbitrary filesystem reads | ✅ Path validated against `getCollectedDataDir()` |
| Invalid default model `gpt-5.2` | ✅ Defaults to `gpt-4o` |
| Profile load failure loop on corrupt JSON | ✅ `safeLoadProfile()` with fallback to cached profile |
| No data verification before queuing processing | ✅ `verifyDataWritten()` check added |

---

## Sprint 1 — Reliability and Integration

**Goal:** Every component works correctly end-to-end. A real user can set up, start, and see the first management run complete successfully.

### Tasks

**S1-1 ✅ DONE: Scheduler threading in `create_pipeline` tool**
- Fixed: `makeCreatePipelineTool(scheduler)` factory function passes scheduler reference through from `getDaemonTools()`. Newly created pipelines are immediately registered with `SchedulerEngine.schedulePipeline()` without restart.

**S1-2 ✅ DONE: Validate inbound chatId against profile**
- Fixed: The daemon checks `msg.chatId !== authorizedChatId` before queuing any Telegram message. Messages from non-configured senders are dropped silently.

**S1-3 (P1): Complete WhatsApp alert delivery**
- Problem: `deliverMessage()` in `alert-tools.ts` only logs to console for WhatsApp.
- Fix: Import the WhatsApp channel singleton and call its `send()` method. Mirror the Telegram implementation.
- Files: `src/tools/daemon/alert-tools.ts`

**S1-4 (P1): Profile corruption recovery**
- Problem: If `profile.json` is corrupted, behavior is undefined.
- Fix: `safeLoadProfile()` already added. Next: write a backup to `profile.json.bak` before every save.
- Files: `src/daemon/profile.ts`

**S1-5 (P1): Startup health check for stuck pipelines**
- Problem: If daemon crashes while a pipeline is `running`, that pipeline is permanently stuck.
- Fix: In `WealthAgentDaemon.start()`, after `restoreSchedules()`, find any pipelines with status `running` where `lastRunAt` is more than 10 minutes ago, reset them to `scheduled`.
- Files: `src/daemon/daemon.ts`

**S1-6 (P0 TESTING): End-to-end integration test**
- Write a test that: creates a test profile → simulates a management run → verifies pipeline is scheduled → simulates pipeline firing → verifies `pipeline_complete` event → simulates processing agent → verifies `send_alert` called correctly
- Framework: Bun test runner with mocked LLM responses
- Files: `src/daemon/daemon.test.ts` (new)

**S1-7 (P1 DOCS): Process supervisor configuration**
- Add `docs/DEPLOYMENT.md` covering: systemd unit, PM2 `ecosystem.config.js`, recommended VPS specs, health monitoring

**Sprint 1 Exit Criteria:**
- [ ] `bun run daemon:setup` completes without error
- [ ] `bun run daemon` starts, triggers management run, creates a pipeline, schedules it — verified by logs without restart
- [ ] Messages from unknown Telegram `chatId` are rejected ✅
- [ ] Integration test passes: pipeline lifecycle from management → scheduling → execution → alert

---

## Sprint 2 — Quality and User Experience

**Goal:** Processing agent makes high-quality decisions. Management agent handles edge cases. User experience of setup and status is polished.

### Tasks

**S2-1 (P1): Management agent quality improvements**
- Cancel pipelines for: (a) event dates that have passed, (b) tickers no longer in the portfolio
- Add logic to reset `failed` pipelines: rewrite script, retest, reschedule (max 2 retries)
- Enforce 90-day forward-looking window in prompt

**S2-2 (P1): Processing agent alert quality**
- Enforce structured alert format: `{ headline, specifics, thesisImpact, recommendation, nextCatalyst }`
- Update `sendAlertTool` schema and `formatForTelegram()` to render this structure cleanly
- Every alert must include: exact percentages, thesis reference, specific quantity recommendation, next catalyst date

**S2-3 (P1): Morning briefing implementation**
- Add `briefing_run` wake event type
- If `profile.delivery.briefingCron` is set, schedule a briefing cron that pushes `briefing_run` to the queue
- Briefing: portfolio P&L vs goals, upcoming events this week, open thesis questions

**S2-4 (P1): Improve `daemon:status` output**
- Show next scheduled run time per active pipeline
- Show thesis coverage (which holdings have thesis notes, which don't)
- Show Telegram connection status and last management run time

**S2-5 (P1): Alert delivery failure resilience**
- When `send_alert` fails after retries, write to `~/.dexter/alerts-failed.jsonl`
- On daemon startup, attempt re-delivery of any queued failed alerts before first management run

**S2-6: Reactive agent quality review**
- Verify reactive agent references specific positions ("Your NVDA at $420 avg...")
- Verify profile updates ("I bought TSLA") trigger `add_holding` and then a management run

**Sprint 2 Exit Criteria:**
- [ ] Processing agent alerts include exact numbers, thesis reference, quantity recommendation, next catalyst
- [ ] Management agent correctly cancels stale pipelines
- [ ] Morning briefing fires on schedule and sends a coherent portfolio summary
- [ ] `daemon:status` shows next run times and thesis coverage
- [ ] Failed alerts are persisted to disk and retried on restart

---

## Sprint 3 — Robustness and Coverage

**Goal:** Additional event types work. System handles real-world messiness. Test coverage solid.

### Tasks

**S3-1: Collection script template library**
- Reference collection scripts for each event type:
  - `ex_dividend-collect.ts` — fetches ex-div date and dividend amount
  - `filing_10q-collect.ts` — fetches 10-Q, extracts MD&A and financials
  - `filing_8k-collect.ts` — fetches 8-K, extracts relevant items
  - `price_alert-collect.ts` — fetches current price, compares to threshold
- Files: `src/daemon/script-templates/`

**S3-2: Market context weekly update**
- Management agent updates market context on Monday runs or when context is older than 7 days

**S3-3: Portfolio drift detection (P2 pull-forward)**
- If any position exceeds `maxPositionPct`, add a `price_alert` pipeline or send a direct proactive alert

**S3-4: Comprehensive logging**
- Structured logging to `~/.dexter/daemon.log` (newline-delimited JSON)
- Log rotation: cap at 10MB
- Correlation IDs tying a single pipeline run's logs together

**S3-5: Configuration validation on startup**
- Preflight checklist: profile exists (warn), Telegram token set (warn), financial API key set (warn), LLM key set (fail loudly if absent)

**S3-6: Test suite expansion**
- Unit tests: `SchedulerEngine.restoreSchedules()`, `WakeQueue` async behavior, `buildProfileContext()`, `findExistingPipeline()` deduplication, `read_collected_data` path validation, alert `formatForTelegram()`
- Target: >80% line coverage on `src/daemon/`

**S3-7: User documentation**
- `docs/DAEMON.md`: setup guide, how pipelines work, how to read `daemon:status`, how to customize alert thresholds, FAQ

**Sprint 3 Exit Criteria:**
- [ ] All event types have tested collection script templates
- [ ] Market context updates automatically
- [ ] Test coverage on daemon directory > 80%
- [ ] `docs/DAEMON.md` complete and accurate

---

## Sprint 4 — Production Readiness

**Goal:** Daemon is ready for real users. Dogfooded through at least one real event. Launch checklist green.

### Tasks

**S4-1: Live integration test on a real portfolio**
- Deploy on VPS with a real holding
- Run through a complete earnings cycle (or historical simulation)
- Verify: Telegram alert arrives with correct data, processing agent decision is sound

**S4-2: Dogfood period (1 week)**
- 3–5 internal users run the daemon on real portfolios
- Collect feedback on: setup experience, alert quality, false positives/negatives, missing event types
- File P0/P1 bugs; schedule P2 items for backlog

**S4-3: Security review**
- Audit `buildSafeEnv()` — confirm no sensitive keys leak to scripts
- Audit file permissions on created files (`profile.json` → 0o600, credentials dir → 0o700)
- Verify `.gitignore` covers all state files

**S4-4: Performance profiling**
- Measure management agent wall-clock time for a 10-holding portfolio
- Measure LLM token usage per agent run; target < $0.50/day for a typical user

**S4-5: Release preparation**
- Bump version in `package.json` (CalVer)
- Tag release, create GitHub release with install instructions

### Launch Checklist

```
[ ] bun run daemon:setup completes in < 5 minutes
[ ] bun run daemon starts without errors when all env vars are set
[ ] bun run daemon:status shows correct pipeline and profile information
[ ] Management agent creates at least one pipeline on a fresh profile
[ ] Pipeline fires on schedule and data is collected correctly
[ ] Processing agent sends alert to Telegram with correct format
[ ] Reactive agent responds to "how is my portfolio doing" with position-specific data
[ ] Alert delivery retries on Telegram rate limit
[ ] Daemon survives restart and restores all pipeline schedules
[ ] Stuck "running" pipelines are reset on startup (S1-5)
[ ] Messages from unknown Telegram chatIds are rejected ✅
[ ] Collection scripts cannot access LLM API keys (verify subprocess env)
[ ] Failed alerts are persisted and retried on restart (S2-5)
[ ] Profile JSON corruption returns null from safeLoadProfile() ✅
[ ] bun test — all tests green
[ ] bun run typecheck — no errors
[ ] Security audit complete
[ ] docs/DAEMON.md complete and reviewed
[ ] At least 3 real users ran daemon for 7+ days without critical bugs
[ ] LLM cost per user per day estimated and documented
```

---

## P1 Backlog (from PE review)

The following items were surfaced by the principal engineer review and are not yet assigned to a sprint:

- **Atomic file writes** — `profile.ts`, `memory.ts`, `pipelines.ts` all use read-modify-write without locks. Write to temp file then `rename()` for crash-safe atomic writes.
- **Pipeline crash recovery** — Pipelines stuck in `running` at startup should be reset to `scheduled` (S1-5 above). Also check for partial output files before queuing processing.
- **Failed pipeline user notification** — When a collection script fails, send a brief Telegram notice (currently fails silently).
- **Processing agent structured output** — Enforce `{ decision: 'ALERT' | 'NO_ACTION', rationale, alert? }` to prevent silent max-iteration failure.
- **Management agent duplicate pipeline guard** — Normalize description strings or use ticker+eventType+eventDate as the dedup key. Track `lastManagementRunDate` to skip redundant daily runs.
- **WhatsApp delivery stub warning** — Setup wizard should warn that WhatsApp alerts are not yet delivered.
- **OS-level sandbox hardening** — `HOME` in sandbox grants access to `~/.ssh` and all credential stores. Separate OS user, `chroot`, or container bind-mount.
- **Profile staleness during long agent runs** — System prompt receives profile at agent start; `read_profile` tool returns live disk state. Remove profile from system prompt; always use the tool for current data.
- **Financial advice disclaimer** — Reactive agent produces specific buy/sell recommendations. Add a configurable disclaimer footer to all outbound alerts and replies.

## P2 Backlog

- Multi-user support
- Portfolio drift alerts (detect when position exceeds `maxPositionPct`)
- SEC EDGAR fallback (when transcript API returns 404)
- Processing agent: web search for analyst reactions post-earnings
- Telegram inline reply buttons ([Dismiss] [Snooze 1wk] [Show Full Analysis])
- Retrospective outcome tracking (track what happened after each recommendation)
- Tax lot awareness (individual tax lots, long-term vs short-term gain recommendations)
- Read-only web dashboard

---

## Critical Path to MVP

```
Setup Wizard → Profile Store → Management Agent → Pipeline Store
  → Code Sandbox → Scheduler Engine (✅ now wired via factory)
  → Collection Scripts → Processing Agent → Alert Delivery → Telegram
```

The scheduler wiring fix (S1-1) was the single biggest unresolved dependency. It is now resolved. The critical path is unblocked.

---

## Architecture Decision Log

| Decision | Rationale |
|---|---|
| `makeCreatePipelineTool(scheduler)` factory | Avoids global singleton; wires new pipelines into live scheduler without restart |
| `outputDataPath` in pipeline definition | Collection script and processing agent always agree on where data lives; prevents mismatch |
| `resolvers: Array<() => void>` in WakeQueue | Prevents event loss when multiple events arrive before the loop drains the queue |
| `safeLoadProfile()` with cached fallback | Prevents corrupt profile from causing an infinite error loop in the event loop |
| `verifyDataWritten()` before queuing processing | Prevents processing agent from running against empty input and producing hallucinated analysis |
| Binary ALERT/NO_ACTION decision | Forces the processing agent to commit to a recommendation rather than summarize |
| Three separate agent roles | Different tools, different prompts, different risk profiles — avoids capability confusion |
| Reactive agent runs concurrently | User messages never block scheduled pipeline execution |
| croner `protect: true` | Prevents overlapping runs of the same cron job |
