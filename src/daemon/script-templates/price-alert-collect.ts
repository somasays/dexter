/**
 * TEMPLATE: Price Alert Collection Script
 *
 * Fetches current price snapshot and compares to a configured threshold.
 * Used for monitoring technical levels, stop-losses, or thesis-invalidation prices.
 *
 * Variables the agent fills in:
 *   - TICKER: e.g. "TSLA"
 *   - ALERT_THRESHOLD_PRICE: e.g. "200.00" (price level to watch, from env or hardcoded)
 *   - ALERT_DIRECTION: "above" | "below" — trigger when price is above or below threshold
 *
 * Environment: ALERT_THRESHOLD_PRICE can also be passed via env var for flexibility.
 *
 * Run: bun run this-script.ts
 * Output: DEXTER_COLLECTED_DIR/{TICKER}/price_alert/{DATE}/
 * Exit 0 always (even if threshold not breached) — processing agent decides.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TICKER = 'TSLA';
const ALERT_THRESHOLD_PRICE = parseFloat(process.env.ALERT_THRESHOLD_PRICE ?? '200.00');
const ALERT_DIRECTION: 'above' | 'below' = 'below'; // trigger if price falls below threshold

const DATE = new Date().toISOString().split('T')[0]; // today
const BASE_URL = 'https://api.financialdatasets.ai';
const API_KEY = process.env.FINANCIAL_DATASETS_API_KEY ?? '';
const OUTPUT_DIR = join(
  process.env.DEXTER_COLLECTED_DIR ?? `${process.env.HOME}/.dexter/collected`,
  TICKER,
  'price_alert',
  DATE
);

async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: API_KEY ? { 'X-API-KEY': API_KEY } : {},
      });
      if (res.ok) return res;
      console.warn(`WARN: HTTP ${res.status} for ${url} (attempt ${i + 1}/${retries + 1})`);
    } catch (err) {
      console.warn(`WARN: Fetch error (attempt ${i + 1}/${retries + 1}): ${err}`);
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Failed to fetch after ${retries + 1} attempts: ${url}`);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  let currentPrice: number | null = null;

  // 1. Current price snapshot
  try {
    const url = `${BASE_URL}/prices/snapshot/?ticker=${TICKER}`;
    const res = await fetchWithRetry(url);
    const data = (await res.json()) as { snapshot?: { price?: number } };
    await writeFile(join(OUTPUT_DIR, 'price-snapshot.json'), JSON.stringify(data, null, 2));
    currentPrice = data.snapshot?.price ?? null;
    console.log(`COLLECTED: price-snapshot (current: $${currentPrice})`);
  } catch (err) {
    console.warn(`WARN: Price snapshot failed — ${err}`);
  }

  // 2. Recent price history (5 days context)
  try {
    const url = `${BASE_URL}/prices/?ticker=${TICKER}&limit=5`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'price-history.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: price-history');
  } catch (err) {
    console.warn(`WARN: Price history failed — ${err}`);
  }

  // 3. Price check result — processing agent uses this to decide ALERT vs NO_ACTION
  const thresholdBreached =
    currentPrice !== null &&
    ((ALERT_DIRECTION === 'below' && currentPrice < ALERT_THRESHOLD_PRICE) ||
      (ALERT_DIRECTION === 'above' && currentPrice > ALERT_THRESHOLD_PRICE));

  const priceCheck = {
    ticker: TICKER,
    currentPrice,
    threshold: ALERT_THRESHOLD_PRICE,
    direction: ALERT_DIRECTION,
    thresholdBreached,
    checkedAt: new Date().toISOString(),
    message: thresholdBreached
      ? `${TICKER} is ${ALERT_DIRECTION} threshold: $${currentPrice} ${ALERT_DIRECTION === 'below' ? '<' : '>'} $${ALERT_THRESHOLD_PRICE}`
      : `${TICKER} at $${currentPrice} — threshold not breached (watching for ${ALERT_DIRECTION} $${ALERT_THRESHOLD_PRICE})`,
  };

  await writeFile(join(OUTPUT_DIR, 'price-check.json'), JSON.stringify(priceCheck, null, 2));
  console.log(`PRICE CHECK: ${priceCheck.message}`);

  console.log(`\nDone. Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
