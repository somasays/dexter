/**
 * Thesis memory tools for the agent.
 * Allow the agent to read and write per-ticker investment theses and action logs.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  loadThesis,
  saveThesis,
  upsertThesisEntry,
  appendActionLog,
  loadActionLog,
  loadMarketContext,
  saveMarketContext,
  listThesisTickers,
  formatThesisForContext,
  type ThesisEntry,
} from '../../daemon/memory.js';

export const readThesisTool = new DynamicStructuredTool({
  name: 'read_thesis',
  description: `Read the investment thesis and analysis history for a specific ticker.
Always read this before processing any event (earnings, filing, price alert) related to a holding.
Returns the core thesis, key metrics to watch, alert thresholds, and recent history.`,
  schema: z.object({
    ticker: z.string().describe('Ticker symbol (e.g. AAPL)'),
  }),
  func: async ({ ticker }) => {
    const thesis = await loadThesis(ticker.toUpperCase());
    if (!thesis) {
      return formatToolResult({
        ticker: ticker.toUpperCase(),
        exists: false,
        message: 'No thesis yet for this ticker. Consider writing one.',
      });
    }
    return formatToolResult({
      thesis,
      formatted: formatThesisForContext(thesis),
    });
  },
});

export const writeThesisTool = new DynamicStructuredTool({
  name: 'write_thesis',
  description: `Create or update the investment thesis for a ticker.
Write this when you first start monitoring a holding, or when the thesis meaningfully changes.
Include: core thesis, key metrics to watch, and alert thresholds (natural language).`,
  schema: z.object({
    ticker: z.string(),
    thesis: z.string().describe('Core investment thesis (2-4 sentences)'),
    keyMetricsToWatch: z
      .array(z.string())
      .describe('Specific metrics that define thesis validity (e.g. "services revenue growth YoY")'),
    alertThresholds: z
      .string()
      .describe(
        'Natural language description of when to alert user (e.g. "services growth below 10% YoY OR guidance cut OR margin below 27%")'
      ),
    openQuestions: z.array(z.string()).optional().describe('Things still uncertain about the thesis'),
  }),
  func: async ({ ticker, thesis, keyMetricsToWatch, alertThresholds, openQuestions }) => {
    const existing = await loadThesis(ticker.toUpperCase());
    await saveThesis({
      ticker: ticker.toUpperCase(),
      thesis,
      keyMetricsToWatch,
      alertThresholds,
      openQuestions: openQuestions ?? existing?.openQuestions ?? [],
      history: existing?.history ?? [],
      updatedAt: new Date().toISOString(),
    });
    return formatToolResult({
      success: true,
      ticker: ticker.toUpperCase(),
      message: `Thesis written for ${ticker.toUpperCase()}.`,
    });
  },
});

export const appendThesisEntryTool = new DynamicStructuredTool({
  name: 'append_thesis_entry',
  description: `Add a new entry to a ticker's analysis history after processing an event.
Call this after every earnings, filing, or significant event analysis.`,
  schema: z.object({
    ticker: z.string(),
    event: z.string().describe('Event name (e.g. "Q1 2026 Earnings", "10-K Filing 2025")'),
    note: z
      .string()
      .describe('Key findings from analysis (2-4 sentences). Be specific with numbers.'),
    decision: z
      .enum(['no_action', 'add', 'trim', 'exit', 'watch'])
      .describe('What action was taken or recommended'),
  }),
  func: async ({ ticker, event, note, decision }) => {
    await upsertThesisEntry(ticker.toUpperCase(), event, note, decision as ThesisEntry['decision']);
    return formatToolResult({ success: true, ticker: ticker.toUpperCase(), event, decision });
  },
});

export const logActionTool = new DynamicStructuredTool({
  name: 'log_action',
  description: `Log a decision made (or not made) to the action log.
Record every significant analysis outcome for retrospective review and pattern learning.`,
  schema: z.object({
    ticker: z.string(),
    event: z.string(),
    decision: z.string().describe('The decision made (e.g. "ALERT sent: trim 30 shares", "NO_ACTION: thesis intact")'),
    rationale: z.string().describe('Why this decision was made'),
  }),
  func: async ({ ticker, event, decision, rationale }) => {
    await appendActionLog({
      date: new Date().toISOString(),
      ticker: ticker.toUpperCase(),
      event,
      decision,
      rationale,
    });
    return formatToolResult({ success: true });
  },
});

export const readActionLogTool = new DynamicStructuredTool({
  name: 'read_action_log',
  description: `Read the recent action log to understand what decisions have been made.
Useful for the management agent to avoid duplicate pipelines or re-analyzing events.`,
  schema: z.object({
    ticker: z.string().optional().describe('Filter by ticker (omit for all recent entries)'),
    limit: z.number().default(20),
  }),
  func: async ({ ticker, limit }) => {
    const log = await loadActionLog();
    const filtered = ticker
      ? log.filter((e) => e.ticker === ticker.toUpperCase())
      : log;
    const recent = filtered.slice(-limit);
    return formatToolResult({ entries: recent, total: filtered.length });
  },
});

export const saveMarketContextTool = new DynamicStructuredTool({
  name: 'save_market_context',
  description: `Save the current macro/market context summary for use in future analyses.
Update this weekly or after major macro events (Fed meeting, CPI release, etc.).`,
  schema: z.object({
    summary: z.string().describe('Current macro environment summary'),
    keyThemes: z.array(z.string()).describe('Key macro themes affecting markets'),
    sectorOutlooks: z
      .record(z.string(), z.string())
      .optional()
      .describe('Sector-specific outlooks (e.g. { "tech": "bullish - strong AI capex cycle" })'),
  }),
  func: async ({ summary, keyThemes, sectorOutlooks }) => {
    await saveMarketContext({ summary, keyThemes, sectorOutlooks });
    return formatToolResult({ success: true, message: 'Market context saved.' });
  },
});

export const readMarketContextTool = new DynamicStructuredTool({
  name: 'read_market_context',
  description: `Read the saved macro/market context. Use this to understand the current environment when analyzing events.`,
  schema: z.object({}),
  func: async () => {
    const ctx = await loadMarketContext();
    if (!ctx) return formatToolResult({ exists: false, message: 'No market context saved yet.' });
    return formatToolResult({ context: ctx });
  },
});

export const listMemoryTool = new DynamicStructuredTool({
  name: 'list_memory',
  description: `List all tickers that have thesis notes in memory.`,
  schema: z.object({}),
  func: async () => {
    const tickers = await listThesisTickers();
    return formatToolResult({ tickers, count: tickers.length });
  },
});
