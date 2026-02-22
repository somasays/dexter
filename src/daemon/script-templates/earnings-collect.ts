/**
 * TEMPLATE: Earnings Collection Script
 *
 * The management agent generates scripts like this automatically.
 * This template shows the pattern for collecting earnings data.
 *
 * Variables the agent fills in:
 *   - TICKER: e.g. "AAPL"
 *   - PERIOD: e.g. "Q1-2026"
 *   - YEAR: e.g. "2026"
 *   - QUARTER: e.g. "Q1"
 *
 * Run: bun run this-script.ts
 * Output: DEXTER_COLLECTED_DIR/{TICKER}/earnings/{PERIOD}/
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TICKER = 'AAPL';
const YEAR = '2026';
const QUARTER = 'Q1';
const PERIOD = `${QUARTER}-${YEAR}`;

const BASE_URL = 'https://api.financialdatasets.ai';
const API_KEY = process.env.FINANCIAL_DATASETS_API_KEY ?? '';
const OUTPUT_DIR = join(process.env.DEXTER_COLLECTED_DIR ?? `${process.env.HOME}/.dexter/collected`, TICKER, 'earnings', PERIOD);

async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      headers: API_KEY ? { 'X-API-KEY': API_KEY } : {},
    });
    if (res.ok) return res;
    if (i < retries) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Failed to fetch: ${url}`);
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // 1. Try to fetch earnings transcript
  try {
    const url = `${BASE_URL}/earnings/transcripts/?ticker=${TICKER}&year=${YEAR}&quarter=${QUARTER}`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'transcript.json'), JSON.stringify(data, null, 2));
    console.log(`COLLECTED: transcript (${JSON.stringify(data).length} bytes)`);
  } catch (err) {
    console.warn(`WARN: Transcript not available — ${err}`);
  }

  // 2. Fetch income statement (actuals)
  try {
    const url = `${BASE_URL}/financials/income-statements/?ticker=${TICKER}&period=quarterly&limit=5`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'income-statements.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: income-statements');
  } catch (err) {
    console.warn(`WARN: Income statements failed — ${err}`);
  }

  // 3. Fetch analyst estimates for context
  try {
    const url = `${BASE_URL}/financials/revenue-estimates/?ticker=${TICKER}&period=quarterly&limit=4`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'estimates.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: estimates');
  } catch (err) {
    console.warn(`WARN: Estimates failed — ${err}`);
  }

  // 4. Fetch key metrics
  try {
    const url = `${BASE_URL}/financials/metrics/?ticker=${TICKER}&period=quarterly&limit=4`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'metrics.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: metrics');
  } catch (err) {
    console.warn(`WARN: Metrics failed — ${err}`);
  }

  console.log(`\nDone. Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
