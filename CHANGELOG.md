# Changelog

All notable changes to this project will be documented in this file.

Format: [YYYY.MM.DD] for CalVer releases.

---

## [2026.2.22] — Daemon Mode v1.0

### Added

**Daemon Mode** — the core feature of this release. An autonomous, always-on
portfolio monitoring agent that runs in the background, collects financial event
data on schedule, and delivers Telegram alerts when something warrants your
attention.

#### Core pipeline loop
- `WealthAgentDaemon` — event-loop driven daemon with management, processing, and reactive agent orchestration (`src/daemon/daemon.ts`)
- `SchedulerEngine` — croner-based pipeline scheduler with live registration (fixes created-but-never-scheduled bug) (`src/daemon/scheduler.ts`)
- `WakeQueue` — async event queue with correct push/next behavior for concurrent events (`src/daemon/wake-queue.ts`)
- Three LLM agent roles: **management** (daily discovery and pipeline creation), **processing** (post-collection analysis and alert decision), **reactive** (inbound Telegram message handling)

#### Agents and tools
- Management agent prompt with Step 0 (market context refresh), Step 1b (portfolio drift detection), and full workflow (`src/daemon/prompts.ts`)
- Processing agent prompt with structured alert decision logic
- Reactive agent prompt for conversational portfolio queries
- Tool registry with per-agent tool sets (`src/daemon/tools.ts`)
- Profile tools: `read_profile`, `update_profile`, `add_holding`, `remove_holding`, `add_goal` (`src/tools/daemon/profile-tools.ts`)
- Memory tools: `read_thesis`, `write_thesis`, `append_thesis_entry`, `log_action`, `read_action_log`, `save_market_context`, `read_market_context`, `list_memory` (`src/tools/daemon/memory-tools.ts`)
- Pipeline tools: `create_pipeline`, `list_pipelines`, `check_pipeline_exists`, `cancel_pipeline`, `mark_pipeline_tested` (`src/tools/daemon/pipeline-tools.ts`)
- Code execution tools: `write_script`, `test_script`, `run_script`, `read_collected_data` (`src/tools/code/execute-script.ts`)
- Alert tools: `send_alert` (structured 7-field schema), `send_reply`, `retryFailedAlerts` (`src/tools/daemon/alert-tools.ts`)

#### Collection script templates
Five reference templates for the management agent to customize:
- `earnings-collect.ts` — earnings transcript, income statements, estimates, metrics
- `ex-dividend-collect.ts` — dividend history, metrics
- `filing-10q-collect.ts` — income statements, balance sheets, cash flow, metrics
- `filing-8k-collect.ts` — recent 8-K filings, price context
- `price-alert-collect.ts` — price snapshot vs configured threshold

#### Infrastructure
- `FinancialProfile` store with CRUD, backup, `0600` permissions (`src/daemon/profile.ts`)
- Thesis memory with 500-entry action log cap (`src/daemon/memory.ts`)
- Pipeline JSON store with lifecycle tracking (`src/daemon/pipelines.ts`)
- Interactive setup wizard: `bun run daemon:setup` (`src/daemon/setup.ts`)
- Structured `daemon:status` with next run time, thesis coverage, Telegram status
- Structured NDJSON daemon log at `~/.dexter/daemon.log` with 10MB rotation (`src/utils/daemon-logger.ts`)
- Startup preflight check — summarizes configured components, hard exits on missing LLM key
- Failed alert persistence to `~/.dexter/alerts-failed.jsonl` with retry on startup
- Morning briefing: `briefing_run` event type driven by `delivery.briefingCron`
- Agent token usage logging (input/output tokens per run)

#### Security
- Telegram `chatId` guard rejects all senders when no profile is configured, and any sender whose chatId doesn't match the profile
- Script subprocess environment allowlist explicitly excludes LLM API keys and bot tokens
- Profile JSON written with `0600` file permissions after every save
- `.gitignore` covers `~/.dexter/` to prevent accidental credential commits

### Documentation
- `docs/DAEMON.md` — full user guide (setup, status, pipeline lifecycle, debugging, FAQ, cost estimates)
- `docs/DEPLOYMENT.md` — production deployment with systemd unit and PM2 `ecosystem.config.js`
- `README.md` — Daemon Mode section

### Tests
- 85 tests, 0 failures across 9 test files
- Daemon test suite: WakeQueue, pipeline lifecycle, profile mutations, memory, scheduler, alert retry, daemon logger, preflight

---

## [Pre-daemon baseline]

Interactive CLI agent (`bun start`) with:
- Task planning and self-reflection
- Real-time financial data (income statements, balance sheets, cash flow, metrics)
- Web search (Exa + Tavily)
- Evaluation suite with LangSmith integration
- WhatsApp gateway (message yourself to interact)
