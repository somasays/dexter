/**
 * TEMPLATE: 8-K Filing Collection Script
 *
 * Fetches the most recent 8-K (Current Report) for a ticker.
 * 8-Ks are filed for material events: earnings pre-releases, M&A, guidance changes,
 * CEO changes, restatements, etc.
 *
 * Variables the agent fills in:
 *   - TICKER: e.g. "NVDA"
 *   - EXPECTED_DATE: ISO date of when the event is expected, e.g. "2026-06-01"
 *
 * Run: bun run this-script.ts
 * Output: DEXTER_COLLECTED_DIR/{TICKER}/filing_8k/{EXPECTED_DATE}/
 * Exit 0 on success (even partial), exit 1 on fatal error.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TICKER = 'NVDA';
const EXPECTED_DATE = '2026-06-01';

const BASE_URL = 'https://api.financialdatasets.ai';
const API_KEY = process.env.FINANCIAL_DATASETS_API_KEY ?? '';
const OUTPUT_DIR = join(
  process.env.DEXTER_COLLECTED_DIR ?? `${process.env.HOME}/.dexter/collected`,
  TICKER,
  'filing_8k',
  EXPECTED_DATE
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

  // 1. Recent 8-K filings (last 5)
  let filings: unknown[] = [];
  try {
    const url = `${BASE_URL}/filings/?ticker=${TICKER}&form_type=8-K&limit=5`;
    const res = await fetchWithRetry(url);
    const data = (await res.json()) as { filings?: unknown[] };
    filings = data.filings ?? [];
    await writeFile(join(OUTPUT_DIR, '8k-filings.json'), JSON.stringify(data, null, 2));
    console.log(`COLLECTED: 8k-filings (${filings.length} filings)`);
  } catch (err) {
    console.warn(`WARN: 8-K filing list not available — ${err}`);
  }

  // 2. Context: price snapshot around the event date
  try {
    const url = `${BASE_URL}/prices/?ticker=${TICKER}&limit=5`;
    const res = await fetchWithRetry(url);
    const data = await res.json();
    await writeFile(join(OUTPUT_DIR, 'price-context.json'), JSON.stringify(data, null, 2));
    console.log('COLLECTED: price-context');
  } catch (err) {
    console.warn(`WARN: Price context failed — ${err}`);
  }

  // 3. Summary
  const summary = {
    ticker: TICKER,
    expectedDate: EXPECTED_DATE,
    filingType: '8-K',
    filingsFound: filings.length,
    collectedAt: new Date().toISOString(),
    files: ['8k-filings.json', 'price-context.json'],
    note: 'Check 8k-filings.json for the most recent material event disclosures.',
  };
  await writeFile(join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log(`\nDone. Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
