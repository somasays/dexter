/**
 * TEMPLATE: Ex-Dividend Collection Script
 *
 * Fetches ex-dividend date, dividend amount, yield, and payout history.
 * The management agent customizes TICKER and EXPECTED_EX_DATE when creating a pipeline.
 *
 * Variables the agent fills in:
 *   - TICKER: e.g. "AAPL"
 *   - EXPECTED_EX_DATE: ISO date, e.g. "2026-05-09"
 *
 * Run: bun run this-script.ts
 * Output: DEXTER_COLLECTED_DIR/{TICKER}/ex_dividend/{EXPECTED_EX_DATE}/
 * Exit 0 on success (even partial), exit 1 on fatal error.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TICKER = 'AAPL';
const EXPECTED_EX_DATE = '2026-05-09';

const BASE_URL = 'https://api.financialdatasets.ai';
const API_KEY = process.env.FINANCIAL_DATASETS_API_KEY ?? '';
const OUTPUT_DIR = join(
  process.env.DEXTER_COLLECTED_DIR ?? `${process.env.HOME}/.dexter/collected`,
  TICKER,
  'ex_dividend',
  EXPECTED_EX_DATE
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
      console.warn(`WARN: Fetch error for ${url} (attempt ${i + 1}/${retries + 1}): ${err}`);
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Failed to fetch after ${retries + 1} attempts: ${url}`);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // 1. Dividend history (actuals)
  try {
    const url = `${BASE_URL}/financials/dividends/?ticker=${TICKER}&limit=8`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'dividend-history.json'), JSON.stringify(data, null, 2));
    console.log(`COLLECTED: dividend-history (${JSON.stringify(data).length} bytes)`);
  } catch (err) {
    console.warn(`WARN: Dividend history not available — ${err}`);
  }

  // 2. Key financial metrics (for yield calculation context)
  try {
    const url = `${BASE_URL}/financials/metrics/?ticker=${TICKER}&period=annual&limit=2`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'metrics.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: metrics');
  } catch (err) {
    console.warn(`WARN: Metrics not available — ${err}`);
  }

  // 3. Summary JSON with the key dividend info for the processing agent
  const summary = {
    ticker: TICKER,
    expectedExDate: EXPECTED_EX_DATE,
    collectedAt: new Date().toISOString(),
    note: 'See dividend-history.json for full payout history.',
  };
  await writeFile(join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\nDone. Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
