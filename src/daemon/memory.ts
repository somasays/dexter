/**
 * Thesis Memory
 *
 * Per-ticker living documents the agent maintains across sessions.
 * Captures investment thesis, key metrics, history of analysis, and open questions.
 * The agent reads relevant notes before processing any event related to a holding.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDexterDir } from './profile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export interface ThesisEntry {
  date: string; // ISO date
  event: string; // e.g. "Q1 2026 Earnings", "DCF Analysis", "Manual note"
  note: string;
  decision: 'no_action' | 'add' | 'trim' | 'exit' | 'watch';
}

export interface TickerThesis {
  ticker: string;
  thesis: string; // core investment thesis
  keyMetricsToWatch: string[]; // specific metrics that matter for this thesis
  alertThresholds: string; // natural language description of when to alert
  history: ThesisEntry[];
  openQuestions: string[];
  updatedAt: string;
}

export interface ActionLogEntry {
  date: string;
  ticker: string;
  event: string;
  decision: string;
  rationale: string;
  outcome?: string; // filled in retrospectively
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

export function getMemoryDir(): string {
  return join(getDexterDir(), 'memory');
}

export function getThesisPath(ticker: string): string {
  return join(getMemoryDir(), `${ticker.toUpperCase()}-thesis.json`);
}

export function getActionLogPath(): string {
  return join(getMemoryDir(), 'action-log.json');
}

export function getMarketContextPath(): string {
  return join(getMemoryDir(), 'market-context.json');
}

async function ensureMemoryDir(): Promise<void> {
  await mkdir(getMemoryDir(), { recursive: true });
}

export async function loadThesis(ticker: string): Promise<TickerThesis | null> {
  const path = getThesisPath(ticker);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as TickerThesis;
}

export async function saveThesis(thesis: TickerThesis): Promise<void> {
  await ensureMemoryDir();
  thesis.updatedAt = new Date().toISOString();
  await writeFile(getThesisPath(thesis.ticker), JSON.stringify(thesis, null, 2), 'utf-8');
}

export async function upsertThesisEntry(
  ticker: string,
  event: string,
  note: string,
  decision: ThesisEntry['decision'] = 'no_action'
): Promise<void> {
  const existing = await loadThesis(ticker);
  const entry: ThesisEntry = { date: new Date().toISOString(), event, note, decision };
  if (existing) {
    existing.history.push(entry);
    await saveThesis(existing);
  } else {
    await saveThesis({
      ticker: ticker.toUpperCase(),
      thesis: '',
      keyMetricsToWatch: [],
      alertThresholds: '',
      history: [entry],
      openQuestions: [],
      updatedAt: new Date().toISOString(),
    });
  }
}

export async function loadActionLog(): Promise<ActionLogEntry[]> {
  const path = getActionLogPath();
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as ActionLogEntry[];
}

export async function appendActionLog(entry: ActionLogEntry): Promise<void> {
  await ensureMemoryDir();
  const log = await loadActionLog();
  log.push(entry);
  // Keep last 500 entries
  const trimmed = log.slice(-500);
  await writeFile(getActionLogPath(), JSON.stringify(trimmed, null, 2), 'utf-8');
}

export async function loadMarketContext(): Promise<Record<string, unknown> | null> {
  const path = getMarketContextPath();
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

export async function saveMarketContext(context: Record<string, unknown>): Promise<void> {
  await ensureMemoryDir();
  await writeFile(
    getMarketContextPath(),
    JSON.stringify({ ...context, updatedAt: new Date().toISOString() }, null, 2),
    'utf-8'
  );
}

export async function listThesisTickers(): Promise<string[]> {
  if (!existsSync(getMemoryDir())) return [];
  const files = await readdir(getMemoryDir());
  return files
    .filter((f) => f.endsWith('-thesis.json'))
    .map((f) => f.replace('-thesis.json', ''));
}

export function formatThesisForContext(thesis: TickerThesis): string {
  const recentHistory = thesis.history.slice(-5);
  const historyStr = recentHistory
    .map((h) => `  [${h.date.split('T')[0]}] ${h.event}: ${h.note} → ${h.decision}`)
    .join('\n');

  return `### ${thesis.ticker} Thesis
${thesis.thesis || '(no thesis written yet)'}

**Key Metrics:** ${thesis.keyMetricsToWatch.join(', ') || '(none set)'}
**Alert Thresholds:** ${thesis.alertThresholds || '(none set)'}
**Open Questions:** ${thesis.openQuestions.join('; ') || '(none)'}

**Recent History:**
${historyStr || '  (no history yet)'}`;
}
