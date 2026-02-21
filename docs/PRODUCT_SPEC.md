# Dexter — Product Specification

> **Dexter is a self-organizing autonomous wealth agent.**
> The user never sets tasks. The agent reads the financial profile, discovers what it needs to monitor,
> builds the tools to collect that data, schedules them, and alerts only when action is required.

---

## The Core Problem

Most financial tools are reactive: they require the user to ask the right question at the right time. Earnings calls are missed. Thesis-breaking events slip by. Positions erode while the user is busy with life.

Dexter inverts this. The user describes who they are and what they own — once — and the agent takes it from there.

---

## What Dexter Does (End-to-End)

**Example: AAPL Earnings**

1. Agent reads profile → knows portfolio includes AAPL
2. Agent discovers → AAPL has an earnings call in 6 weeks
3. Agent writes → a Bun TypeScript script that will collect the transcript and 10-Q when published
4. Agent tests → dry-runs the script, verifies it works, fixes issues autonomously
5. Agent schedules → script to run the evening earnings are published
6. Script fires (no human involved) → transcript collected and stored
7. Agent wakes → reads transcript, analyzes against AAPL investment thesis
8. Decision A: "Revenue beat but services deceleration for third consecutive quarter. Thesis at risk."
   → Alert sent: specific recommendation, position size context, next catalyst to watch
9. Decision B: "In-line quarter. Services +11%, thesis intact."
   → Agent updates thesis notes and goes back to sleep. User never bothered.

**The user never scheduled anything. The agent derived this from knowing: "I own AAPL."**

---

## User Experience Principles

1. **Zero task-setting** — Agent derives all monitoring needs from the financial profile
2. **Alert sparingly** — Silence is the default; every notification is actionable
3. **Every alert includes a recommendation** — Not "AAPL reported earnings" but "trim 30 shares because X"
4. **Thesis-driven, not price-driven** — Monitors fundamentals vs the investment thesis, not price movements
5. **Transparent on demand** — User can always ask "what are you monitoring and why?"
6. **Secure by construction** — Scripts never see API credentials; all data stays in `~/.dexter/`

---

## The Financial Profile

The user defines their financial identity once, via an interactive setup wizard or structured profile file:

```jsonc
{
  "name": "Alex",
  "riskTolerance": "moderate-aggressive",
  "investmentHorizon": "long-term",
  "preferredChannel": "telegram",
  "telegramChatId": "123456789",
  "holdings": [
    { "ticker": "AAPL", "shares": 100, "costBasis": 165.00, "targetAllocation": 0.25 },
    { "ticker": "NVDA", "shares": 50, "costBasis": 420.00, "targetAllocation": 0.15 }
  ],
  "watchlist": ["MSFT", "META"],
  "goals": [
    { "type": "wealth_growth", "description": "Grow portfolio 15% annually over 5 years" }
  ],
  "constraints": {
    "avoidSectors": [],
    "maxSinglePositionPct": 0.30
  }
}
```

---

## Thesis Memory

Each holding has a living investment thesis document the agent maintains:

```markdown
# AAPL Investment Thesis
**Position:** 100 shares | Cost: $165 | Current: ~$211 | Allocation: 25%
**Last updated:** 2026-04-30 by processing agent

## Core Thesis
Services revenue growth diversifies away from iPhone unit cycles.
Capital returns (buybacks + dividends) enhance per-share value.

## Key Metrics to Watch
- Services revenue growth (YoY): THESIS REQUIRES >10% — currently 11% ✅
- Operating margin: should remain >30% — currently 31.2% ✅

## History
- 2026-01-31: Q4 2025 — Strong services (+13%). NO ACTION.
- 2026-04-30: Q1 2026 — Services +11%. In-line. NO ACTION.
```

The agent writes and updates this. It reads it before processing each new event. It is not re-deriving the thesis from scratch — it is building on prior reasoning.

---

## Alert Format

When action is warranted, the alert is specific and actionable:

```
🚨 AAPL Q1 2026 — ACTION RECOMMENDED

Beat on revenue (+3.2%) but services growth decelerated to +8% (vs 11% last quarter
and analyst consensus of 10%). Third consecutive quarter of services deceleration —
a threat to your core thesis.

YOUR POSITION: 100 shares @ $165 avg. Currently $211. +$4,600 unrealised gain.

RECOMMENDATION: Trim 30 shares (~$6,300). Realise some gains. Reduce allocation
from 25% → 18% pending evidence services growth re-accelerates.

NEXT CATALYST: WWDC June 2026 (AI integration updates). I'll monitor.
```

When no action is warranted, the user hears nothing. The agent updates its notes silently.

---

## What Dexter Is (and Isn't)

**This is:**
- A personal autonomous research and monitoring agent
- A self-organizing pipeline system that builds its own data collection infrastructure
- A thesis-driven alert system that only speaks when it has something actionable to say

**This is NOT:**
- An automated trader (no order execution, no brokerage API)
- A robo-advisor (no regulatory compliance, no fiduciary responsibility)
- A prediction engine (it analyzes and recommends; the human decides)

---

## Minimum Viable Version

The single scenario that proves the vision:

> Agent reads portfolio → discovers AAPL earnings → writes + tests collection script → schedules it → wakes on schedule → collects transcript → decides whether to alert → sends message only if action needed

End-to-end pipeline for one ticker, one event type. Everything else is iteration.
