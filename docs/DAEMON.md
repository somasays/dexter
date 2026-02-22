# Dexter Daemon Mode

Daemon Mode is the autonomous, always-on component of Dexter. It monitors your portfolio around the clock, collects data when events occur, and sends you a Telegram or WhatsApp message only when something genuinely warrants your attention.

## What it is (and isn't)

**Daemon Mode is:**
- An autonomous agent running on a server (or your machine)
- A pipeline system that collects earnings data, filings, dividends, and price alerts on schedule
- A portfolio analyst that reads the data and decides: ALERT or NO_ACTION
- A Telegram/WhatsApp bot that responds to portfolio questions

**Daemon Mode is not:**
- A trading bot (it never places orders)
- A real-time price ticker
- A multi-user system (one profile per daemon instance)

---

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Your Telegram chat ID (from [@userinfobot](https://t.me/userinfobot))
- An OpenAI or Anthropic API key
- Financial Datasets API key (from [financialdatasets.ai](https://financialdatasets.ai))

---

## Setup walkthrough

### Step 1: Create your `.env` file

```bash
cp env.example .env
```

Edit `.env` and set at minimum:

```env
# Required
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=...
FINANCIAL_DATASETS_API_KEY=...
DEXTER_DAEMON_MODEL=gpt-4o

# Optional but recommended
EXASEARCH_API_KEY=...     # for web search in management runs
TAVILY_API_KEY=...        # fallback web search
```

### Step 2: Run the setup wizard

```bash
bun run daemon:setup
```

The wizard collects:
- Your name
- Holdings (ticker, shares, cost basis, account type)
- Goals (retirement, home purchase, etc.)
- Risk tolerance
- Telegram or WhatsApp delivery preference

This creates `~/.dexter/profile.json` (permissions: `0600`).

### Step 3: Start the daemon

```bash
bun run daemon
```

On startup, you'll see the preflight check:

```
[daemon] Preflight check:
  Profile:          FOUND (Alex, 3 holdings)
  Telegram:         CONFIGURED
  LLM provider:     OpenAI (gpt-4o)
  Financial data:   CONFIGURED (FINANCIAL_DATASETS_API_KEY set)
  Web search:       Exa
  Active pipelines: 0 scheduled

[daemon] Preflight complete. Starting event loop.
```

The daemon then triggers a management run that discovers upcoming events and creates monitoring pipelines.

---

## How to read `daemon:status`

```bash
bun run daemon:status
```

Example output:

```
══════════════════════════════════════════
  Dexter Daemon Status
══════════════════════════════════════════

## Financial Profile: Alex
...

── Channels ──
Telegram: CONFIGURED
Delivery channel: telegram → 123456789
Morning briefing: 0 7 * * 1-5 (next: 2/24/2026, 7:00 AM)

── Management ──
Last management run: 2/22/2026, 6:00:00 AM

── Pipelines ──
Active: 2  |  Completed: 1  |  Failed: 0
  [scheduled ] AAPL Q1 2026 Earnings
               cron: 0 21 28 4 *  →  next: 4/28/2026, 9:00 PM
  [scheduled ] NVDA Q1 2026 Earnings
               cron: 0 21 28 5 *  →  next: 5/28/2026, 9:00 PM

── Thesis Coverage ──
Holdings with thesis: 2 / 3
Missing thesis: MSFT (management agent will write these)
```

Fields to pay attention to:
- **Next run time**: When the collection script will execute. If `never`, the cron expression is invalid.
- **Missing thesis**: Holdings without thesis notes get no personalized analysis. The management agent writes these on the next run.
- **Failed pipelines**: Listed separately. The management agent retries them on the next run.

---

## How pipelines work

A pipeline has a lifecycle:

```
scheduled → running → completed
                   ↘ failed
```

1. **scheduled**: Waiting for the cron to fire
2. **running**: Collection script executing
3. **completed**: Data collected and processed
4. **failed**: Script errored or timed out

On daemon startup, any pipeline stuck in `running` for more than 10 minutes is reset to `scheduled`.

**To inspect a pipeline:**
```bash
cat ~/.dexter/pipelines/<pipeline-id>.json
```

**To cancel a pipeline**, send a message to your Telegram bot:
> Cancel the AAPL earnings pipeline

Or the management agent cancels them automatically when the event date passes or the holding is removed.

---

## How to customize alert thresholds

Thesis notes are stored in `~/.dexter/memory/` as JSON files. You can read them:

```bash
cat ~/.dexter/memory/AAPL-thesis.json
```

The `alertThresholds` field controls when the processing agent sends alerts:

```json
{
  "alertThresholds": "Alert if EPS misses by >5%, if Services growth < 12%, or if management lowers guidance"
}
```

Edit this file directly, or tell the daemon:
> Update the AAPL thesis — alert threshold should be EPS miss >3%

---

## How to add or remove positions

**Via Telegram message:**
> I bought 50 shares of GOOGL at $175

> I sold all my TSLA

The reactive agent calls `add_holding` or `remove_holding` and confirms. The management agent will pick up the new holding on the next run and create monitoring pipelines.

**By editing `profile.json`:**
```bash
nano ~/.dexter/profile.json
```

The daemon reloads the profile on every event.

---

## How to debug a failed pipeline

**1. Check the pipeline JSON:**
```bash
cat ~/.dexter/pipelines/<id>.json
```
Look at `status`, `collection.lastRunAt`, and `collection.testResult`.

**2. Check the collection script:**
```bash
cat ~/.dexter/scripts/<id>-collect.ts
```

**3. Run the script manually:**
```bash
DEXTER_COLLECTED_DIR=/tmp/test-run bun run ~/.dexter/scripts/<id>-collect.ts
```

**4. Check the daemon log:**
```bash
tail -n 50 ~/.dexter/daemon.log | jq .
```

The log is NDJSON — each line is a structured log entry with `timestamp`, `level`, `component`, and `message`.

**5. Check collected data:**
```bash
ls ~/.dexter/collected/<TICKER>/<event-type>/
```

---

## FAQ

**Why didn't I get an alert?**

Most events result in NO_ACTION — this is by design. The processing agent only alerts when something genuinely warrants your attention. To understand a specific decision, check the action log:

```bash
cat ~/.dexter/memory/action-log.json | jq '.[-5:]'
```

Or ask the daemon directly:
> Why didn't you alert me about the AAPL earnings?

**How do I make alerts more/less sensitive?**

Edit the `alertThresholds` in the thesis file for that ticker. More specific thresholds = fewer alerts. Broader thresholds = more alerts.

**What does the daemon cost to run?**

Approximate daily LLM cost for a 3-holding portfolio on `gpt-4o`:

| Event | Tokens (est.) | Cost/run |
|---|---|---|
| Management run (daily) | ~20K input / 2K output | ~$0.06 |
| Processing agent (per event) | ~15K input / 1K output | ~$0.05 |
| Morning briefing (daily) | ~8K input / 500 output | ~$0.02 |
| Reactive query (per message) | ~10K input / 500 output | ~$0.03 |

Typical daily cost: **$0.08–$0.15** depending on number of events processed.

On `gpt-4o-mini`, costs drop to approximately **$0.01–$0.02/day**.

**The daemon crashed. How do I recover?**

```bash
# Check if any pipelines are stuck
bun run daemon:status

# Restart the daemon — it will reset stuck pipelines and retry failed alerts on startup
bun run daemon
```

**How do I view daemon logs?**

```bash
# Last 100 lines, pretty-printed
tail -n 100 ~/.dexter/daemon.log | jq .

# Only errors
cat ~/.dexter/daemon.log | jq 'select(.level == "error")'

# Management run events only
cat ~/.dexter/daemon.log | jq 'select(.component == "management")'
```

---

## Data directory reference

```
~/.dexter/
├── profile.json          # financial profile (0600)
├── profile.json.bak      # auto-backup before each save
├── daemon-state.json     # last management run timestamp
├── daemon.log            # structured NDJSON log (rotates at 10MB → daemon.log.1)
├── alerts-failed.jsonl   # failed alerts queued for retry on next startup
├── pipelines/            # one JSON per pipeline
│   └── AAPL-earnings-<ts>.json
├── scripts/              # agent-generated collection scripts
│   └── AAPL-earnings-<ts>-collect.ts
├── collected/            # raw data from collection scripts
│   └── AAPL/earnings/Q1-2026/
│       ├── transcript.json
│       ├── income-statements.json
│       └── estimates.json
└── memory/               # thesis notes and action log
    ├── AAPL-thesis.json
    ├── NVDA-thesis.json
    ├── action-log.json
    └── market-context.json
```
