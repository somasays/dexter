/**
 * Financial Profile Store
 *
 * Persistent record of the user's financial identity, portfolio, and goals.
 * The agent reads this at every wake to personalise every interaction.
 */

import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export interface Holding {
  ticker: string;
  shares: number;
  costBasis: number; // per share, in currency
  account: 'taxable' | 'IRA' | 'Roth IRA' | '401k' | 'other';
  notes?: string;
}

export interface FinancialGoal {
  id: string;
  description: string;
  targetAmount: number;
  targetDate: string; // ISO date
  priority: 'primary' | 'secondary';
  currentProgress?: number; // current value toward this goal
}

export interface PortfolioConstraints {
  avoidSectors?: string[];
  avoidTickers?: string[];
  maxPositionPct?: number; // max % of portfolio in any one position
  rebalanceThreshold?: number; // trigger rebalance when drift exceeds this %
}

export interface FinancialProfile {
  /** Display name for personalised messages */
  name: string;
  timezone: string;
  currency: string;

  /** Risk profile */
  riskTolerance: 'conservative' | 'moderate' | 'moderate-aggressive' | 'aggressive';
  timeHorizon: string; // e.g. "10-15 years"
  investmentPhilosophy?: string; // e.g. "long-term growth, value investing"
  taxSituation?: string; // e.g. "long-term gains preferred, high bracket"

  /** Wealth goals */
  goals: FinancialGoal[];

  /** Portfolio */
  holdings: Holding[];
  cash: number;
  watchlist: string[]; // tickers to monitor but not held

  /** Constraints */
  constraints: PortfolioConstraints;

  /** Delivery preferences */
  delivery: {
    channel: 'telegram' | 'whatsapp';
    chatId: string; // Telegram chat ID or WhatsApp phone
    timezone: string;
    briefingCron?: string; // default morning briefing cron (e.g. "0 7 * * 1-5")
  };

  /** Metadata */
  createdAt: string;
  updatedAt: string;
}

export type ProfileUpdate = Partial<Omit<FinancialProfile, 'createdAt'>>;

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

export function getDexterDir(): string {
  // DEXTER_DIR env var allows overriding the data directory (used in tests and custom setups)
  return process.env.DEXTER_DIR ?? join(homedir(), '.dexter');
}

export function getProfilePath(): string {
  return join(getDexterDir(), 'profile.json');
}

const PROFILE_DEFAULTS: Omit<FinancialProfile, 'name' | 'delivery'> = {
  timezone: 'America/New_York',
  currency: 'USD',
  riskTolerance: 'moderate',
  timeHorizon: 'long-term',
  goals: [],
  holdings: [],
  cash: 0,
  watchlist: [],
  constraints: { maxPositionPct: 25, rebalanceThreshold: 0.05 },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export async function loadProfile(): Promise<FinancialProfile | null> {
  const path = getProfilePath();
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as FinancialProfile;
}

export async function saveProfile(profile: FinancialProfile): Promise<void> {
  const dir = getDexterDir();
  await mkdir(dir, { recursive: true });
  // Back up the existing profile before overwriting so corrupt saves are recoverable
  const profilePath = getProfilePath();
  if (existsSync(profilePath)) {
    await copyFile(profilePath, `${profilePath}.bak`).catch(() => {/* non-fatal */});
  }
  profile.updatedAt = new Date().toISOString();
  await writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
}

export async function createDefaultProfile(
  name: string,
  deliveryChannel: 'telegram' | 'whatsapp',
  chatId: string
): Promise<FinancialProfile> {
  const profile: FinancialProfile = {
    ...PROFILE_DEFAULTS,
    name,
    delivery: {
      channel: deliveryChannel,
      chatId,
      timezone: PROFILE_DEFAULTS.timezone,
      briefingCron: '0 7 * * 1-5',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveProfile(profile);
  return profile;
}

export async function updateProfile(updates: ProfileUpdate): Promise<FinancialProfile> {
  const current = await loadProfile();
  if (!current) throw new Error('No profile found. Run: bun run dexter daemon setup');
  const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };
  await saveProfile(merged);
  return merged;
}

export async function addHolding(holding: Holding): Promise<FinancialProfile> {
  const profile = await loadProfile();
  if (!profile) throw new Error('No profile found.');
  const existing = profile.holdings.findIndex((h) => h.ticker === holding.ticker);
  if (existing >= 0) {
    profile.holdings[existing] = holding;
  } else {
    profile.holdings.push(holding);
  }
  // Remove from watchlist if now held
  profile.watchlist = profile.watchlist.filter((t) => t !== holding.ticker);
  return updateProfile({ holdings: profile.holdings, watchlist: profile.watchlist });
}

export async function removeHolding(ticker: string): Promise<FinancialProfile> {
  const profile = await loadProfile();
  if (!profile) throw new Error('No profile found.');
  return updateProfile({ holdings: profile.holdings.filter((h) => h.ticker !== ticker) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Context builder (for system prompt injection)
// ─────────────────────────────────────────────────────────────────────────────

export function buildProfileContext(profile: FinancialProfile): string {
  const holdingLines = profile.holdings.map(
    (h) =>
      `  - ${h.ticker}: ${h.shares} shares @ $${h.costBasis.toFixed(2)} avg (${h.account})`
  );

  const goalLines = profile.goals.map(
    (g) =>
      `  - ${g.description} [${g.priority}]: $${g.targetAmount.toLocaleString()} by ${g.targetDate}`
  );

  const watchlistStr =
    profile.watchlist.length > 0 ? profile.watchlist.join(', ') : '(none)';

  return `## Financial Profile: ${profile.name}

**Risk Tolerance:** ${profile.riskTolerance}
**Time Horizon:** ${profile.timeHorizon}
${profile.investmentPhilosophy ? `**Philosophy:** ${profile.investmentPhilosophy}` : ''}
${profile.taxSituation ? `**Tax Situation:** ${profile.taxSituation}` : ''}

**Portfolio Holdings:**
${holdingLines.length > 0 ? holdingLines.join('\n') : '  (no holdings yet)'}
**Cash Position:** $${profile.cash.toLocaleString()}
**Watchlist:** ${watchlistStr}

**Goals:**
${goalLines.length > 0 ? goalLines.join('\n') : '  (no goals set)'}

**Constraints:** Max position ${profile.constraints.maxPositionPct ?? 25}% | Rebalance threshold ${((profile.constraints.rebalanceThreshold ?? 0.05) * 100).toFixed(0)}%
${profile.constraints.avoidSectors?.length ? `Avoid sectors: ${profile.constraints.avoidSectors.join(', ')}` : ''}`;
}
