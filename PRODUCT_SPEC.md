# Dexter Daemon — Product Requirements Document

**Version:** 1.0
**Date:** 2026-02-21
**Status:** Approved — Ground Truth for Engineering
**Repo:** https://github.com/virattt/dexter

---

## Product Vision Statement

Dexter Daemon is an always-on, autonomous wealth management agent that lives on the user's infrastructure, continuously monitors their portfolio without prompting, and reaches out only when something genuinely warrants action. Unlike passive dashboards or reactive chatbots, Dexter behaves like a dedicated personal analyst who never sleeps: it wakes itself on schedule, discovers upcoming financial events, writes and deploys its own data collection scripts, reads the results, reasons about them in the context of the user's specific thesis and risk profile, and delivers a precise recommendation via Telegram or WhatsApp — then goes back to sleep until it is needed again.

---

## Problem Statement

### The core problem retail investors face is not lack of information — it is lack of continuous, personalized attention.

**Pain 1 — Reactive, not proactive.** Individual investors miss earnings calls, analyst day updates, and ex-dividend dates because they are not watching every ticker every day. They find out about material events after the price has already moved.

**Pain 2 — Generic alerts have no context.** Price alert apps send "NVDA is down 5%" with no analysis. The user still has to decide if that move breaks their investment thesis or is just noise. That decision requires reading the earnings transcript, comparing to estimates, and knowing their own cost basis and goals.

**Pain 3 — Professional wealth management is inaccessible.** Institutional analysts track every holding, know the thesis for each position, and only surface actionable insights. This level of continuous coverage costs hundreds of thousands per year in advisory fees. Retail investors get nothing equivalent.

**Pain 4 — Portfolio context is fragmented.** A user's holdings span brokerages, their thesis lives in a note app, their goals are in their head. No tool connects all of these to incoming market events.

**What Dexter Daemon solves:** It provides always-on, thesis-aware portfolio monitoring that surfaces only the events that matter, with the specific numbers and a concrete recommendation, delivered where the user already is.

---

## Target User Persona

### "The Active Self-Directed Investor"

**Name:** Alex
**Age:** 35–55
**Portfolio size:** $50k–$2M
**Account types:** Mix of taxable brokerage, IRA, Roth IRA

**Behavior patterns:**
- Holds 5–20 individual stocks with conviction; not an index-only investor
- Has a thesis for each position but it lives in their head or scattered notes
- Misses earnings calls 40% of the time because of work or travel
- Reads financial news but cannot differentiate signal from noise in real time
- Uses a brokerage app, financial news apps, and some combination of Reddit/Twitter for ideas
- Technically comfortable: uses CLI tools, has a home server or always-on laptop, can set up API keys

**Goals:**
- Not miss anything that changes the thesis on a core holding
- Know the day after earnings whether they need to act
- Have a way to ask "how is my portfolio doing relative to my goals?" without opening six apps
- Reduce the emotional, reactive trading that comes from seeing a red portfolio without context

**Frustrations:**
- Earnings surprises they read about two days after the fact
- Spending 90 minutes doing post-earnings research themselves every quarter per holding
- Generic "portfolio trackers" that show prices but have no opinion
- AI chatbots that are helpful but have no memory of previous conversations or their positions

**Technical profile:**
- Comfortable running `bun run daemon` on a server or always-on machine
- Can set up a Telegram bot token; not afraid of `.env` files
- Will not write code but can follow setup documentation

---

## Core User Journeys

### Journey 1: Initial Setup (Day 0)

**Goal:** Get Dexter running and monitoring an existing portfolio within 30 minutes.

1. User clones the repo and installs dependencies with `bun install`
2. User copies `env.example` to `.env` and adds their OpenAI/Anthropic key and `FINANCIAL_DATASETS_API_KEY`
3. User creates a Telegram bot via @BotFather, adds `TELEGRAM_BOT_TOKEN` to `.env`
4. User finds their Telegram chat ID by messaging @userinfobot
5. User runs `bun run daemon:setup` — the interactive CLI wizard prompts for:
   - First name
   - Preferred alert channel (Telegram or WhatsApp) and chat ID
   - Risk tolerance (conservative / moderate / moderate-aggressive / aggressive)
   - Time horizon and investment philosophy
   - Holdings (ticker, shares, cost basis, account type) — entered one at a time
   - Watchlist tickers
   - Primary financial goal (description, target amount, target date)
   - Morning briefing schedule (cron expression, defaults to weekdays 7am)
6. Profile is saved to `~/.dexter/profile.json`
7. User runs `bun run daemon` — daemon starts, immediately triggers the first management run
8. Within 10 minutes, the management agent has discovered upcoming events, written collection scripts, and scheduled them
9. User receives a Telegram message: "Dexter is now monitoring your portfolio. I found 3 upcoming earnings events and scheduled data collection for each."

**Success criteria:** Profile exists, at least one pipeline is scheduled, Telegram is connected.

---

### Journey 2: Automated Earnings Monitoring (Ongoing)

**Goal:** User wakes up the morning after an earnings call and has already received a precise, actionable summary.

1. Daemon management agent runs daily at 6am UTC, discovers that AAPL reports Q2 earnings on May 1
2. Management agent checks: no existing pipeline for `AAPL-earnings-Q2-2026`
3. Management agent writes a collection script that fetches: earnings transcript, income statement actuals, analyst consensus estimates, key metrics
4. Management agent tests the script: exit code 0, output contains expected JSON keys
5. Pipeline is created with `scheduleCron: "0 21 1 5 *"` (9pm ET on May 1, two hours after market close)
6. On May 1 at 9pm, the scheduler fires the pipeline; the collection script runs as a subprocess
7. Script writes structured JSON to `~/.dexter/collected/AAPL/earnings/Q2-2026/`
8. A `pipeline_complete` event is queued; the processing agent wakes
9. Processing agent reads the AAPL thesis (growth driven by Services segment, key metric: Services revenue YoY), reads market context, reads all collected files
10. Processing agent compares: Services revenue grew 11.2% vs consensus 14.8% — a material miss
11. Alert threshold is triggered: "services growth below 10% YoY OR guidance cut"
12. Processing agent sends Telegram alert: "AAPL Q2: Services rev $26.1B (+11.2% YoY) missed consensus $27.4B (+14.8%) significantly. Product gross margin 37.2% vs 37.8% est. Guidance light: FY rev $395B vs $402B est. This challenges the Services growth thesis. Recommend: trim 15–20% of position before the thesis confirms recovery. Next catalyst: WWDC June 9."
13. User reads the message on their phone, decides whether to act, and responds "trim 50 shares" — the reactive agent updates the profile accordingly

**Success criteria:** Alert arrives with specific numbers, thesis reference, actionable recommendation, and next catalyst — before user has to go look for it.

---

### Journey 3: Ad-Hoc Conversation (Reactive Mode)

**Goal:** User asks a portfolio-specific question via Telegram and gets an answer that uses their stored context.

1. User sends: "How are my tech holdings doing vs my retirement goal?"
2. The Telegram inbound handler adds a `message` event to the wake queue
3. Reactive agent wakes with the user's full profile injected into the system prompt
4. Agent reads the action log and recent thesis entries for AAPL, NVDA, MSFT
5. Agent fetches current prices and computes portfolio value vs cost basis
6. Agent computes progress toward the user's retirement goal ($2M by 2038)
7. Agent replies: "Your tech holdings (AAPL 120 shares, NVDA 45 shares, MSFT 80 shares) are up $34,200 (18.3%) from cost. Portfolio at $387,400 total. You're 19.4% toward your $2M retirement goal by 2038. At current growth rate you're on track. NVDA is your largest winner (+62% from $420 avg). Any of these you want to review in depth?"
8. User responds: "Add 10 shares of TSLA at $280" — reactive agent calls `add_holding` tool, confirms, and starts a management cycle to create a TSLA pipeline

**Success criteria:** Response references actual position data, actual cost basis, actual goal progress. The user did not have to provide any context.

---

### Journey 4: Self-Healing and Maintenance

**Goal:** Daemon handles stale pipelines and closed positions without user intervention.

1. User sells their entire META position through their brokerage
2. User messages Dexter: "I sold all my META"
3. Reactive agent calls `remove_holding("META")` — META removed from profile
4. On the next management run (next morning at 6am UTC), management agent notices:
   - A META-earnings pipeline is scheduled for next month
   - META is no longer in the portfolio
5. Management agent cancels the pipeline via `cancel_pipeline()`
6. Management agent checks whether any remaining holdings have stale pipelines (event date passed)
7. Two stale pipelines from last quarter are cancelled
8. Management agent confirms there are open questions in the NVDA thesis (written 6 months ago) and updates the thesis based on recent public information it fetches
9. Daily summary is optionally sent: "Cleaned up 3 stale pipelines. Updated NVDA thesis. No new events this week."

**Success criteria:** No orphan pipelines for exited positions; thesis memory stays current.

---

### Journey 5: New Position Onboarding

**Goal:** User buys a new stock and Dexter automatically builds full monitoring coverage within hours.

1. User messages Dexter: "I just bought 25 shares of CRWD at $380"
2. Reactive agent calls `add_holding(CRWD, 25, 380, "taxable")`
3. Reactive agent immediately queues a management run for CRWD specifically
4. Management agent discovers: CRWD reports Q1 FY2027 earnings in ~45 days; no existing pipeline
5. Management agent writes a CRWD-specific collection script (earnings transcript + security sector metrics)
6. Script is tested and passes; pipeline is created
7. Management agent calls `write_thesis` with an initial CRWD thesis based on its knowledge: cybersecurity platform consolidation play, key metrics: net new ARR, gross retention rate, platform module adoption
8. User receives: "Added CRWD position. I've scheduled earnings monitoring for their Q1 report on [date]. Here's my initial thesis: [thesis]. I'll alert you if results challenge this."

**Success criteria:** New position is fully monitored with thesis and scheduled pipeline within one management cycle.

---

## Feature Requirements

### P0 — Must Have (MVP, Daemon is not shippable without these)

**P0-1: Financial Profile Store**
- Acceptance: Profile persists to `~/.dexter/profile.json` across daemon restarts
- Acceptance: Profile includes: name, timezone, currency, risk tolerance, time horizon, investment philosophy, tax situation, holdings (ticker, shares, cost basis, account type), cash, watchlist, goals (description, target, date, priority), constraints (max position %, rebalance threshold, sector avoids), delivery channel and chat ID, briefing cron
- Acceptance: `loadProfile()` returns null (not throws) when no profile exists
- Acceptance: Profile can be created via CLI wizard (`bun run daemon:setup`) and updated via agent tools at runtime

**P0-2: Setup Wizard**
- Acceptance: Interactive terminal wizard collects all required profile fields
- Acceptance: Wizard is idiomatic, gives defaults for optional fields, completes in under 5 minutes
- Acceptance: On completion prints next steps including Telegram setup instructions

**P0-3: Three-Agent Architecture (Management / Processing / Reactive)**
- Acceptance: Management agent runs on schedule (daily 6am UTC) and on daemon start
- Acceptance: Processing agent runs after every successful pipeline collection
- Acceptance: Reactive agent runs for every inbound Telegram or WhatsApp message
- Acceptance: Each agent receives appropriate tool subset (management cannot send alerts; processing cannot write new pipelines; reactive has full access)
- Acceptance: All agents run headlessly with auto-approved file writes; no interactive prompt

**P0-4: Pipeline System**
- Acceptance: Pipelines persist to `~/.dexter/pipelines/{id}.json`
- Acceptance: Pipeline definition includes: ticker, eventType, description, eventDate, scriptPath, scheduleCron, notifyChannel, alertThreshold, position snapshot, thesis snapshot
- Acceptance: Pipeline statuses: `scheduled`, `running`, `completed`, `failed`, `cancelled`
- Acceptance: Management agent checks for existing pipelines before creating new ones (no duplicates)
- Acceptance: Scheduler restores active pipelines from disk on daemon start (survives restarts)

**P0-5: Code Execution Sandbox**
- Acceptance: Management agent can write TypeScript scripts to `~/.dexter/scripts/`
- Acceptance: Scripts run in subprocess with stripped environment — only `FINANCIAL_DATASETS_API_KEY`, `DEXTER_COLLECTED_DIR`, `HOME`, `PATH`, `EXASEARCH_API_KEY`, `TAVILY_API_KEY` are forwarded; no LLM keys, no system credentials
- Acceptance: 30-second timeout on test runs; 120-second timeout on production pipeline runs
- Acceptance: stdout capped at 50KB; script fails gracefully with informative stderr
- Acceptance: Management agent tests each script before creating a pipeline; untested scripts cannot be scheduled

**P0-6: Telegram Gateway**
- Acceptance: Daemon connects to Telegram via `grammy` long-polling when `TELEGRAM_BOT_TOKEN` is set
- Acceptance: Inbound messages from the configured `chatId` wake the reactive agent
- Acceptance: Processing agent can send alerts to the configured `chatId` with urgency prefix (info/warning/critical)
- Acceptance: Alert delivery retries up to 3 times on Telegram rate-limit (HTTP 429)
- Acceptance: Daemon starts without Telegram if `TELEGRAM_BOT_TOKEN` is not set; logs a clear message

**P0-7: Thesis Memory**
- Acceptance: Per-ticker thesis persists to `~/.dexter/memory/{TICKER}-thesis.json`
- Acceptance: Thesis includes: core thesis string, key metrics to watch, alert thresholds (natural language), history of analysis entries, open questions
- Acceptance: Processing agent reads the relevant thesis before every event analysis
- Acceptance: After every event analysis, processing agent appends a thesis history entry with decision (`no_action`, `add`, `trim`, `exit`, `watch`)
- Acceptance: Action log persists to `~/.dexter/memory/action-log.json`, capped at 500 entries

**P0-8: Event Loop and Wake Queue**
- Acceptance: Daemon runs a blocking event loop; sleeps when queue is empty (no busy-wait)
- Acceptance: Four wake event types: `management_run`, `pipeline_complete`, `message`, `scheduled`
- Acceptance: Events are processed sequentially (one agent runs at a time); queue accumulates during processing
- Acceptance: Loop catches and logs errors without crashing the daemon; resumes after 1-second backoff

**P0-9: Daemon Lifecycle Commands**
- Acceptance: `bun run daemon` starts the daemon
- Acceptance: `bun run daemon:setup` runs the interactive wizard
- Acceptance: `bun run daemon:status` prints profile summary and active pipeline list without starting the daemon
- Acceptance: SIGINT and SIGTERM trigger graceful shutdown (stop scheduler, stop Telegram polling)

---

### P1 — Should Have (Required for production-quality release)

**P1-1: Market Context Memory**
- Acceptance: Management agent saves a macro context summary to `~/.dexter/memory/market-context.json`
- Acceptance: Context includes: summary text, key themes array, sector outlooks map
- Acceptance: Processing agent reads market context when analyzing events to calibrate alert sensitivity
- Acceptance: Context is updated weekly or after major macro events (management agent initiative)

**P1-2: WhatsApp Gateway (Production-Quality)**
- Acceptance: WhatsApp channel is fully integrated for alert delivery (not just console log)
- Acceptance: Access control: allowlist by phone number, self-chat mode, pairing code flow for unknown senders
- Acceptance: WhatsApp session persists credentials to `~/.dexter/credentials/whatsapp/`
- Acceptance: Automatic reconnect on disconnect with exponential backoff

**P1-3: Processing Agent Decision Quality**
- Acceptance: Processing agent defaults to `NO_ACTION` — alert only when thesis-breaking
- Acceptance: Alert thresholds are calibrated by risk tolerance: conservative users get more alerts; aggressive users only get high-signal alerts
- Acceptance: Every alert includes: specific metric values with variance from estimates, thesis impact statement, concrete recommendation (hold/add/trim/exit with suggested quantity), next catalyst date
- Acceptance: Processing agent always logs to the action log regardless of alert vs. no-action decision

**P1-4: Management Agent Quality Gates**
- Acceptance: Management agent never creates a pipeline for an event date that has already passed
- Acceptance: Management agent cancels pipelines for tickers no longer in the portfolio
- Acceptance: Management agent looks at least 90 days forward for upcoming events
- Acceptance: If a script test fails, the agent attempts to fix and retest before giving up (maximum 2 retries)

**P1-5: Pipeline Event Types**
- Acceptance: All defined event types are discoverable: `earnings`, `ex_dividend`, `analyst_day`, `filing_10k`, `filing_10q`, `filing_8k`, `price_alert`, `custom`
- Acceptance: Appropriate collection script pattern exists for each event type (earnings is the reference implementation)
- Acceptance: For price alerts: script checks current price against a threshold defined in pipeline `alertThreshold`

**P1-6: Morning Briefing**
- Acceptance: Optional cron-scheduled morning briefing via the reactive agent
- Acceptance: Briefing summarizes: upcoming events this week, portfolio P&L vs. goals, any open thesis questions
- Acceptance: Briefing defaults to weekdays at 7am in the user's configured timezone

**P1-7: Daemon Status Command Completeness**
- Acceptance: `daemon:status` shows: profile summary, all active pipelines with next run time, completed/failed counts, memory ticker list, Telegram connection status

---

### P2 — Nice to Have (Post-MVP backlog)

**P2-1: Multi-User Support**
- Each user gets their own profile and pipeline namespace
- Gateway routes inbound messages to the correct user context based on `chatId`

**P2-2: Portfolio Drift Alerts**
- Management agent detects when a position exceeds `maxPositionPct` due to appreciation
- Proactively alerts user with rebalancing recommendation

**P2-3: Script Template Library**
- Pre-written, tested collection scripts for: earnings, 10-K, 10-Q, 8-K, ex-dividend, insider trades, analyst revisions
- Management agent selects the appropriate template and customizes it per ticker/event

**P2-4: Backtesting the Processing Agent**
- Replay historical events against the processing agent and score alert decisions against actual price action
- Used for calibrating alert thresholds

**P2-5: Retrospective Outcome Tracking**
- After an alert recommends "trim", track whether trimming was actually the right call
- Fill in `ActionLogEntry.outcome` field automatically using subsequent price data
- Weekly summary of past decisions and how they played out

**P2-6: Tax Lot Awareness**
- Track individual tax lots (not just cost basis per position)
- Alert agent recommends specific lots to sell based on long-term vs. short-term gain treatment

**P2-7: Web Dashboard**
- Read-only web UI showing pipeline status, thesis notes, action log
- No trading capability; purely observational

**P2-8: Eval Harness for Daemon Agents**
- Automated test suite for management, processing, and reactive agents against synthetic portfolio scenarios
- Score: pipeline creation accuracy, alert precision/recall, thesis quality

---

## Success Metrics

### Adoption Metrics (3 months post-launch)

| Metric | Target |
|--------|--------|
| Daemons running continuously for 30+ days | 100 users |
| Average pipelines active per user | >= 8 |
| Setup wizard completion rate | >= 85% |
| Users who receive at least one alert in first 30 days | >= 80% |

### Quality Metrics (Ongoing)

| Metric | Target |
|--------|--------|
| Processing agent alert precision (alerts that users rate as actionable) | >= 70% |
| Pipeline collection success rate (scripts complete without error) | >= 90% |
| Daemon uptime (no crashes requiring manual restart) | >= 99% over 30-day windows |
| Reactive agent response time (Telegram message to reply) | <= 30 seconds |
| Management run duration (wall clock) | <= 10 minutes |

### Business Outcome Metrics (6 months post-launch)

| Metric | Target |
|--------|--------|
| Users who report catching a material event before acting on it themselves | >= 50% |
| Reduction in time spent on post-earnings research (self-reported) | >= 60% |
| Net Promoter Score | >= 50 |

---

## Non-Goals

The following are explicitly out of scope and will not be built as part of Dexter Daemon:

1. **Automatic trade execution.** Dexter will never place orders, connect to a brokerage API, or take any financial action on behalf of the user. It recommends; the human decides.

2. **Regulated investment advice.** Dexter is not a licensed financial advisor. It provides information and analysis, not personalized investment advice in the legal sense. All communications should reflect this.

3. **Real-time tick data or high-frequency monitoring.** Dexter is designed for event-driven monitoring at the scale of earnings, filings, and dividends — not minute-by-minute price feeds or algorithmic trading signals.

4. **Multi-brokerage integration.** Dexter does not connect to brokerage APIs (Schwab, Fidelity, Robinhood) to pull live portfolio data. The portfolio is a manually maintained profile. Brokerage sync is a future consideration.

5. **Tax filing or accounting.** Dexter tracks positions for monitoring purposes, not for tax lot accounting, Form 1099 generation, or capital gains calculation.

6. **Social or shared features.** No multi-user sharing of portfolios, thesis notes, or alerts. Dexter is a personal, private agent.

7. **Mobile app.** Dexter is a server-side daemon and CLI tool. Telegram and WhatsApp are the mobile interfaces by design.

8. **Crypto beyond data access.** While the financial tools can fetch crypto price data, Dexter Daemon does not support crypto holdings in the profile schema in MVP. Crypto is P2 scope.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM writes a malformed collection script that hangs or crashes | High (every management run) | Medium (one pipeline fails) | 30s test timeout; subprocess isolation; management agent retry loop; `failed` status prevents re-scheduling |
| LLM generates too many alerts (alert fatigue) | Medium | High (user disables daemon) | Default to `NO_ACTION`; alert thresholds encoded in thesis; risk-tolerance calibration in processing agent prompt; user-configurable alert threshold per pipeline |
| Financial data API (financialdatasets.ai) returns no data for future event | High (common before earnings) | Low (pipeline deferred) | Scripts include retry logic with exponential backoff; management agent instructed to note "data not yet available" and schedule a re-check |
| Telegram bot token exposed in process environment | Low | High (account compromise) | Token only forwarded to LLM subprocess in daemon context (not to collection scripts); `.env` is gitignored; documentation warns against sharing |
| Daemon crashes and pipelines are never executed | Medium | High (missed events) | Scheduler state is persisted to disk and restored on restart; process supervisor (systemd/pm2) recommended in deployment guide |
| User adds incorrect cost basis, causing wrong P&L calculations | Medium | Low (cosmetic error) | Profile is editable via CLI and agent; cost basis is user's responsibility; agent always shows cost basis in alerts so errors are visible |
| API rate limits on LLM provider during management run | Low | Medium (run incomplete) | LangChain retry with exponential backoff; management agent is resumable (checks existing pipelines before creating new ones) |
| Collection script writes data outside `~/.dexter/` | Low | Medium (security boundary violation) | `DEXTER_COLLECTED_DIR` and `DEXTER_OUTPUT_DIR` are the only writable paths injected into subprocess env; scripts cannot discover other paths |
