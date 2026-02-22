/**
 * Sprint 2 tests — expanded coverage for src/daemon/
 *
 * Covers:
 *   1. profile.ts — buildProfileContext, addHolding, removeHolding, chmod 600
 *   2. memory.ts  — formatThesisForContext, appendActionLog cap, listThesisTickers
 *   3. pipelines.ts — getActivePipelines filter, findExistingPipeline all statuses
 *   4. scheduler.ts — schedule, cancel, getNextRun, stopAll
 *   5. alert-tools.ts — retryFailedAlerts JSONL round-trip
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test User',
    timezone: 'America/New_York',
    currency: 'USD',
    riskTolerance: 'moderate' as const,
    timeHorizon: '10 years',
    investmentPhilosophy: 'long-term growth',
    taxSituation: 'high bracket',
    goals: [],
    holdings: [
      { ticker: 'AAPL', shares: 50, costBasis: 150.0, account: 'taxable' as const },
      { ticker: 'NVDA', shares: 20, costBasis: 400.0, account: 'IRA' as const },
    ],
    cash: 5000,
    watchlist: ['MSFT', 'GOOGL'],
    constraints: { maxPositionPct: 25, rebalanceThreshold: 0.05, avoidSectors: ['Tobacco'] },
    delivery: {
      channel: 'telegram' as const,
      chatId: '123456',
      timezone: 'America/New_York',
      briefingCron: '0 7 * * 1-5',
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePipelineRecord(id: string, status: string, ticker = 'AAPL', eventType = 'earnings') {
  return {
    id,
    ticker,
    eventType,
    description: `${ticker} test pipeline ${id}`,
    eventDate: '2026-06-15',
    collection: {
      scriptPath: `/tmp/${id}-collect.ts`,
      scheduleCron: '0 0 31 2 *', // Feb 31 — never fires
      outputDataPath: `/tmp/${id}-data`,
    },
    processing: { notifyChannel: 'telegram' },
    context: {},
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. profile.ts — buildProfileContext
// ─────────────────────────────────────────────────────────────────────────────

describe('buildProfileContext', () => {
  test('includes name, holdings, watchlist, and goals', async () => {
    const { buildProfileContext } = await import('./profile.js');
    const profile = makeProfile();
    const ctx = buildProfileContext(profile);

    expect(ctx).toContain('Test User');
    expect(ctx).toContain('AAPL');
    expect(ctx).toContain('50 shares');
    expect(ctx).toContain('NVDA');
    expect(ctx).toContain('MSFT');
    expect(ctx).toContain('GOOGL');
    expect(ctx).toContain('$5,000');
  });

  test('shows (no holdings yet) when empty', async () => {
    const { buildProfileContext } = await import('./profile.js');
    const profile = makeProfile({ holdings: [] });
    const ctx = buildProfileContext(profile);
    expect(ctx).toContain('(no holdings yet)');
  });

  test('shows philosophy and tax situation when set', async () => {
    const { buildProfileContext } = await import('./profile.js');
    const profile = makeProfile();
    const ctx = buildProfileContext(profile);
    expect(ctx).toContain('long-term growth');
    expect(ctx).toContain('high bracket');
  });

  test('avoidSectors appears when set', async () => {
    const { buildProfileContext } = await import('./profile.js');
    const profile = makeProfile();
    const ctx = buildProfileContext(profile);
    expect(ctx).toContain('Tobacco');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. profile.ts — addHolding, removeHolding, chmod 600
// ─────────────────────────────────────────────────────────────────────────────

describe('profile mutations', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-profile-mut-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('addHolding upserts an existing holding', async () => {
    const { saveProfile, addHolding } = await import('./profile.js');
    const profile = makeProfile();
    await saveProfile(profile);

    const updated = await addHolding({
      ticker: 'AAPL',
      shares: 100,
      costBasis: 160.0,
      account: 'taxable',
    });
    const aapl = updated.holdings.find((h) => h.ticker === 'AAPL');
    expect(aapl).toBeDefined();
    expect(aapl!.shares).toBe(100);
    expect(aapl!.costBasis).toBe(160.0);
    // Should not duplicate
    expect(updated.holdings.filter((h) => h.ticker === 'AAPL').length).toBe(1);
  });

  test('addHolding removes ticker from watchlist when adding as holding', async () => {
    const { saveProfile, addHolding } = await import('./profile.js');
    const profile = makeProfile(); // watchlist has MSFT, GOOGL
    await saveProfile(profile);

    const updated = await addHolding({
      ticker: 'MSFT',
      shares: 30,
      costBasis: 350.0,
      account: 'taxable',
    });
    expect(updated.watchlist).not.toContain('MSFT');
    expect(updated.watchlist).toContain('GOOGL');
  });

  test('removeHolding filters correctly', async () => {
    const { saveProfile, removeHolding } = await import('./profile.js');
    const profile = makeProfile();
    await saveProfile(profile);

    const updated = await removeHolding('AAPL');
    expect(updated.holdings.find((h) => h.ticker === 'AAPL')).toBeUndefined();
    expect(updated.holdings.find((h) => h.ticker === 'NVDA')).toBeDefined();
  });

  test('saveProfile sets file permissions to 0o600', async () => {
    const { saveProfile, getProfilePath } = await import('./profile.js');
    const profile = makeProfile();
    await saveProfile(profile);

    const { stat } = await import('node:fs/promises');
    const s = await stat(getProfilePath());
    // On Linux: mode & 0o777 should be 0o600
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('loadProfile returns null for missing file', async () => {
    const { loadProfile } = await import('./profile.js');
    const result = await loadProfile();
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. memory.ts — formatThesisForContext, appendActionLog cap, listThesisTickers
// ─────────────────────────────────────────────────────────────────────────────

describe('memory.ts', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-memory-${Date.now()}`);
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('formatThesisForContext renders all sections', async () => {
    const { formatThesisForContext } = await import('./memory.js');
    const thesis = {
      ticker: 'AAPL',
      thesis: 'Services flywheel drives margin expansion.',
      keyMetricsToWatch: ['Services revenue growth', 'Gross margin'],
      alertThresholds: 'Alert if Services misses by >2%',
      openQuestions: ['Will Vision Pro drive new revenue streams?'],
      history: [
        {
          date: '2026-01-15T00:00:00.000Z',
          event: 'Q1 2026 Earnings',
          note: 'Beat on EPS by $0.08',
          decision: 'no_action' as const,
        },
      ],
      updatedAt: new Date().toISOString(),
    };

    const ctx = formatThesisForContext(thesis);
    expect(ctx).toContain('AAPL Thesis');
    expect(ctx).toContain('Services flywheel');
    expect(ctx).toContain('Services revenue growth');
    expect(ctx).toContain('Alert if Services misses');
    expect(ctx).toContain('Vision Pro');
    expect(ctx).toContain('Q1 2026 Earnings');
    expect(ctx).toContain('no_action');
  });

  test('formatThesisForContext handles empty thesis gracefully', async () => {
    const { formatThesisForContext } = await import('./memory.js');
    const thesis = {
      ticker: 'EMPTY',
      thesis: '',
      keyMetricsToWatch: [],
      alertThresholds: '',
      openQuestions: [],
      history: [],
      updatedAt: new Date().toISOString(),
    };

    const ctx = formatThesisForContext(thesis);
    expect(ctx).toContain('(no thesis written yet)');
    expect(ctx).toContain('(none set)');
    expect(ctx).toContain('(no history yet)');
  });

  test('formatThesisForContext only shows last 5 history entries', async () => {
    const { formatThesisForContext } = await import('./memory.js');
    const history = Array.from({ length: 8 }, (_, i) => ({
      date: new Date().toISOString(),
      event: `Event ${i}`,
      note: `Note ${i}`,
      decision: 'no_action' as const,
    }));

    const ctx = formatThesisForContext({
      ticker: 'X',
      thesis: 'test',
      keyMetricsToWatch: [],
      alertThresholds: '',
      openQuestions: [],
      history,
      updatedAt: new Date().toISOString(),
    });

    // Only events 3-7 should appear (last 5)
    expect(ctx).not.toContain('Event 0');
    expect(ctx).not.toContain('Event 1');
    expect(ctx).not.toContain('Event 2');
    expect(ctx).toContain('Event 3');
    expect(ctx).toContain('Event 7');
  });

  test('appendActionLog enforces 500-entry cap', async () => {
    const { appendActionLog, loadActionLog } = await import('./memory.js');

    // Write 505 entries
    for (let i = 0; i < 505; i++) {
      await appendActionLog({
        date: new Date().toISOString(),
        ticker: 'AAPL',
        event: `Event ${i}`,
        decision: 'no_action',
        rationale: `Rationale ${i}`,
      });
    }

    const log = await loadActionLog();
    expect(log.length).toBe(500);
    // Should have kept the LAST 500 entries (5-504)
    expect(log[0]?.event).toBe('Event 5');
    expect(log[499]?.event).toBe('Event 504');
  });

  test('listThesisTickers returns tickers with thesis files', async () => {
    const { saveThesis, listThesisTickers } = await import('./memory.js');

    await saveThesis({
      ticker: 'AAPL',
      thesis: 'test',
      keyMetricsToWatch: [],
      alertThresholds: '',
      openQuestions: [],
      history: [],
      updatedAt: new Date().toISOString(),
    });

    await saveThesis({
      ticker: 'NVDA',
      thesis: 'test',
      keyMetricsToWatch: [],
      alertThresholds: '',
      openQuestions: [],
      history: [],
      updatedAt: new Date().toISOString(),
    });

    const tickers = await listThesisTickers();
    expect(tickers).toContain('AAPL');
    expect(tickers).toContain('NVDA');
    expect(tickers.length).toBe(2);
  });

  test('listThesisTickers returns empty array when no memory dir', async () => {
    const { listThesisTickers } = await import('./memory.js');
    // Point to a dir with no memory subdirectory
    const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
    process.env.DEXTER_DIR = emptyDir;
    const tickers = await listThesisTickers();
    expect(tickers).toEqual([]);
    process.env.DEXTER_DIR = tmpDir; // restore
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. pipelines.ts — getActivePipelines, findExistingPipeline all statuses
// ─────────────────────────────────────────────────────────────────────────────

describe('pipelines.ts filtering', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-pipelines-${Date.now()}`);
    await mkdir(join(tmpDir, 'pipelines'), { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writePipeline(id: string, status: string, ticker = 'AAPL') {
    const dir = join(tmpDir, 'pipelines');
    await writeFile(join(dir, `${id}.json`), JSON.stringify(makePipelineRecord(id, status, ticker)));
  }

  test('getActivePipelines returns only scheduled and running', async () => {
    await writePipeline('p-scheduled', 'scheduled');
    await writePipeline('p-running', 'running');
    await writePipeline('p-completed', 'completed');
    await writePipeline('p-failed', 'failed');
    await writePipeline('p-cancelled', 'cancelled');

    const { getActivePipelines } = await import('./pipelines.js');
    const active = await getActivePipelines();
    const ids = active.map((p) => p.id);
    expect(ids).toContain('p-scheduled');
    expect(ids).toContain('p-running');
    expect(ids).not.toContain('p-completed');
    expect(ids).not.toContain('p-failed');
    expect(ids).not.toContain('p-cancelled');
  });

  test('findExistingPipeline returns active pipeline', async () => {
    await writePipeline('aapl-sched', 'scheduled', 'AAPL');
    const { findExistingPipeline } = await import('./pipelines.js');
    const found = await findExistingPipeline('AAPL', 'earnings');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('aapl-sched');
  });

  test('findExistingPipeline ignores cancelled and completed', async () => {
    await writePipeline('aapl-done', 'completed', 'AAPL');
    await writePipeline('aapl-cancelled', 'cancelled', 'AAPL');
    const { findExistingPipeline } = await import('./pipelines.js');
    const found = await findExistingPipeline('AAPL', 'earnings');
    expect(found).toBeNull();
  });

  test('findExistingPipeline is case-insensitive on ticker', async () => {
    await writePipeline('nvda-sched', 'scheduled', 'NVDA');
    const { findExistingPipeline } = await import('./pipelines.js');
    const found = await findExistingPipeline('nvda', 'earnings');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('nvda-sched');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. scheduler.ts — schedule, cancel, getNextRun, stopAll
// ─────────────────────────────────────────────────────────────────────────────

describe('SchedulerEngine', () => {
  test('schedulePipeline registers a job (activeJobCount)', async () => {
    const { SchedulerEngine } = await import('./scheduler.js');
    const engine = new SchedulerEngine(async () => {});
    expect(engine.activeJobCount).toBe(0);

    engine.schedulePipeline({
      id: 'test-1',
      ticker: 'AAPL',
      eventType: 'earnings',
      description: 'Test pipeline',
      eventDate: '2026-06-01',
      collection: {
        scriptPath: '/tmp/test.ts',
        scheduleCron: '0 0 31 2 *', // never fires
        outputDataPath: '/tmp/out',
      },
      processing: { notifyChannel: 'telegram' },
      context: {},
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(engine.activeJobCount).toBe(1);
    engine.stopAll();
  });

  test('cancelPipeline removes the job', async () => {
    const { SchedulerEngine } = await import('./scheduler.js');
    const engine = new SchedulerEngine(async () => {});

    const pipeline = {
      id: 'cancel-test',
      ticker: 'TSLA',
      eventType: 'earnings' as const,
      description: 'Cancel test',
      eventDate: '2026-06-01',
      collection: {
        scriptPath: '/tmp/test.ts',
        scheduleCron: '0 0 31 2 *',
        outputDataPath: '/tmp/out',
      },
      processing: { notifyChannel: 'telegram' as const },
      context: {},
      status: 'scheduled' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    engine.schedulePipeline(pipeline);
    expect(engine.activeJobCount).toBe(1);

    engine.cancelPipeline('cancel-test');
    expect(engine.activeJobCount).toBe(0);
    engine.stopAll();
  });

  test('getNextRun returns null for unknown pipeline', async () => {
    const { SchedulerEngine } = await import('./scheduler.js');
    const engine = new SchedulerEngine(async () => {});
    expect(engine.getNextRun('nonexistent')).toBeNull();
  });

  test('getNextRun returns a Date for a scheduled job', async () => {
    const { SchedulerEngine } = await import('./scheduler.js');
    const engine = new SchedulerEngine(async () => {});

    engine.schedulePipeline({
      id: 'next-run-test',
      ticker: 'AAPL',
      eventType: 'earnings',
      description: 'Next run test',
      eventDate: '2026-06-01',
      collection: {
        scriptPath: '/tmp/test.ts',
        scheduleCron: '0 6 * * *', // daily at 6am — next run is in the future
        outputDataPath: '/tmp/out',
      },
      processing: { notifyChannel: 'telegram' },
      context: {},
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const next = engine.getNextRun('next-run-test');
    expect(next).not.toBeNull();
    expect(next!.getTime()).toBeGreaterThan(Date.now());
    engine.stopAll();
  });

  test('stopAll clears all jobs', async () => {
    const { SchedulerEngine } = await import('./scheduler.js');
    const engine = new SchedulerEngine(async () => {});

    for (let i = 0; i < 3; i++) {
      engine.schedulePipeline({
        id: `job-${i}`,
        ticker: 'AAPL',
        eventType: 'earnings',
        description: `Job ${i}`,
        eventDate: '2026-06-01',
        collection: {
          scriptPath: '/tmp/test.ts',
          scheduleCron: '0 0 31 2 *',
          outputDataPath: '/tmp/out',
        },
        processing: { notifyChannel: 'telegram' },
        context: {},
        status: 'scheduled',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    expect(engine.activeJobCount).toBe(3);
    engine.stopAll();
    expect(engine.activeJobCount).toBe(0);
  });

  test('rescheduling an existing pipeline replaces the old job', async () => {
    const { SchedulerEngine } = await import('./scheduler.js');
    const engine = new SchedulerEngine(async () => {});

    const pipeline = {
      id: 'dup-job',
      ticker: 'AAPL',
      eventType: 'earnings' as const,
      description: 'Dup test',
      eventDate: '2026-06-01',
      collection: {
        scriptPath: '/tmp/test.ts',
        scheduleCron: '0 0 31 2 *',
        outputDataPath: '/tmp/out',
      },
      processing: { notifyChannel: 'telegram' as const },
      context: {},
      status: 'scheduled' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    engine.schedulePipeline(pipeline);
    engine.schedulePipeline(pipeline); // schedule again
    // Should still only be 1 job, not 2
    expect(engine.activeJobCount).toBe(1);
    engine.stopAll();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. alert-tools.ts — retryFailedAlerts JSONL round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('retryFailedAlerts', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-alerts-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
    // Ensure no Telegram token so delivery always fails (we're just testing persistence logic)
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('no-ops when alerts-failed.jsonl does not exist', async () => {
    const { retryFailedAlerts } = await import('../tools/daemon/alert-tools.js');
    await expect(retryFailedAlerts()).resolves.toBeUndefined();
  });

  test('discards malformed JSONL lines without throwing', async () => {
    const path = join(tmpDir, 'alerts-failed.jsonl');
    await writeFile(path, 'not-json\n{"also": "bad"\n', 'utf-8');

    const { retryFailedAlerts } = await import('../tools/daemon/alert-tools.js');
    await expect(retryFailedAlerts()).resolves.toBeUndefined();
  });

  test('keeps failed entries in the file when delivery still fails', async () => {
    const path = join(tmpDir, 'alerts-failed.jsonl');
    const record = {
      timestamp: new Date().toISOString(),
      channel: 'telegram',
      chatId: '999',
      alert: {
        ticker: 'AAPL',
        headline: 'Q2 miss',
        specifics: 'EPS $1.50 vs $1.55',
        thesisImpact: 'Negative',
        recommendation: 'Trim 10%',
        nextCatalyst: 'Q3 earnings',
        urgency: 'high',
      },
    };
    await writeFile(path, JSON.stringify(record) + '\n', 'utf-8');

    const { retryFailedAlerts } = await import('../tools/daemon/alert-tools.js');
    // Delivery will fail (no bot token). Entry should remain.
    await retryFailedAlerts();

    const remaining = await readFile(path, 'utf-8');
    expect(remaining.trim()).not.toBe(''); // not empty — still there
  });
});
