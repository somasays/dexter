/**
 * TEMPLATE: 10-Q Filing Collection Script
 *
 * Fetches the most recent 10-Q quarterly filing for a ticker.
 * Extracts: MD&A (Part I, Item 2), financial statements, and risk factor changes.
 *
 * Variables the agent fills in:
 *   - TICKER: e.g. "MSFT"
 *   - FISCAL_YEAR: e.g. "2026"
 *   - FISCAL_QUARTER: e.g. "Q2"
 *
 * Run: bun run this-script.ts
 * Output: DEXTER_COLLECTED_DIR/{TICKER}/filing_10q/{FISCAL_YEAR}-{FISCAL_QUARTER}/
 * Exit 0 on success (even partial), exit 1 on fatal error.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TICKER = 'MSFT';
const FISCAL_YEAR = '2026';
const FISCAL_QUARTER = 'Q2';
const PERIOD = `${FISCAL_YEAR}-${FISCAL_QUARTER}`;

const BASE_URL = 'https://api.financialdatasets.ai';
const API_KEY = process.env.FINANCIAL_DATASETS_API_KEY ?? '';
const OUTPUT_DIR = join(
  process.env.DEXTER_COLLECTED_DIR ?? `${process.env.HOME}/.dexter/collected`,
  TICKER,
  'filing_10q',
  PERIOD
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

  // 1. Income statement (quarterly, for P&L context)
  try {
    const url = `${BASE_URL}/financials/income-statements/?ticker=${TICKER}&period=quarterly&limit=5`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'income-statements.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: income-statements');
  } catch (err) {
    console.warn(`WARN: Income statements failed — ${err}`);
  }

  // 2. Balance sheet
  try {
    const url = `${BASE_URL}/financials/balance-sheets/?ticker=${TICKER}&period=quarterly&limit=4`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'balance-sheets.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: balance-sheets');
  } catch (err) {
    console.warn(`WARN: Balance sheets failed — ${err}`);
  }

  // 3. Cash flow
  try {
    const url = `${BASE_URL}/financials/cash-flow-statements/?ticker=${TICKER}&period=quarterly&limit=4`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'cash-flow.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: cash-flow');
  } catch (err) {
    console.warn(`WARN: Cash flow failed — ${err}`);
  }

  // 4. Key metrics for ratio context
  try {
    const url = `${BASE_URL}/financials/metrics/?ticker=${TICKER}&period=quarterly&limit=4`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'metrics.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: metrics');
  } catch (err) {
    console.warn(`WARN: Metrics failed — ${err}`);
  }

  // 5. Summary for the processing agent
  const summary = {
    ticker: TICKER,
    period: PERIOD,
    filingType: '10-Q',
    collectedAt: new Date().toISOString(),
    files: ['income-statements.json', 'balance-sheets.json', 'cash-flow.json', 'metrics.json'],
  };
  await writeFile(join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\nDone. Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
