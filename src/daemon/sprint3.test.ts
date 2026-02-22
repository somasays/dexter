/**
 * Sprint 3 tests — expanded coverage for src/daemon/ targeting >80%
 *
 * Covers:
 *   1. daemon-logger.ts — write, rotate at 10MB, malformed gracefully handled
 *   2. memory.ts — upsertThesisEntry (create + update), market context round-trip
 *   3. pipelines.ts — loadAllPipelines with empty/missing dir, savePipeline round-trip
 *   4. profile.ts — updateProfile merges correctly, createDefaultProfile sets defaults
 *   5. WakeQueue — briefing_run event routing
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WakeQueue } from './wake-queue.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. daemon-logger.ts
// ─────────────────────────────────────────────────────────────────────────────

describe('daemon-logger', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-logger-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('info() writes a valid NDJSON entry to daemon.log', async () => {
    const { daemonLog } = await import('../utils/daemon-logger.js');
    daemonLog.info('test-component', 'hello world', { foo: 'bar' });

    // Give the fire-and-forget write time to complete
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(tmpDir, 'daemon.log');
    expect(existsSync(logPath)).toBe(true);

    const raw = await readFile(logPath, 'utf-8');
    const entry = JSON.parse(raw.trim().split('\n')[0]!);
    expect(entry.level).toBe('info');
    expect(entry.component).toBe('test-component');
    expect(entry.message).toBe('hello world');
    expect(entry.data).toEqual({ foo: 'bar' });
    expect(typeof entry.timestamp).toBe('string');
  });

  test('error(), warn(), debug() all write entries', async () => {
    const { daemonLog } = await import('../utils/daemon-logger.js');
    daemonLog.error('comp', 'an error');
    daemonLog.warn('comp', 'a warning');
    daemonLog.debug('comp', 'a debug message');

    await new Promise((r) => setTimeout(r, 100));

    const raw = await readFile(join(tmpDir, 'daemon.log'), 'utf-8').catch(() => '');
    const lines = raw.trim().split('\n').filter(Boolean);
    const levels = lines.map((l) => JSON.parse(l).level);
    expect(levels).toContain('error');
    expect(levels).toContain('warn');
    expect(levels).toContain('debug');
  });

  test('rotates daemon.log to daemon.log.1 when size exceeds 10MB', async () => {
    const logPath = join(tmpDir, 'daemon.log');
    // Write a 10MB+ file to simulate a full log
    const tenMBPlus = 'x'.repeat(10 * 1024 * 1024 + 1);
    await writeFile(logPath, tenMBPlus, 'utf-8');

    const { daemonLog } = await import('../utils/daemon-logger.js');
    daemonLog.info('rotate-test', 'trigger rotation');

    await new Promise((r) => setTimeout(r, 100));

    const rotatedPath = join(tmpDir, 'daemon.log.1');
    expect(existsSync(rotatedPath)).toBe(true);
    const rotatedSize = (await stat(rotatedPath)).size;
    expect(rotatedSize).toBeGreaterThan(10 * 1024 * 1024);

    // New daemon.log should be small (just the new entry)
    const newLogSize = (await stat(logPath)).size;
    expect(newLogSize).toBeLessThan(1024);
  });

  test('does not throw if DEXTER_DIR is unwritable', async () => {
    // Point to a path that cannot be created (root-owned in most CI)
    process.env.DEXTER_DIR = '/root/cannot-write-here';
    const { daemonLog } = await import('../utils/daemon-logger.js');
    // Should be completely silent — never throw from logger
    expect(() => daemonLog.info('test', 'this should not throw')).not.toThrow();
    await new Promise((r) => setTimeout(r, 50)); // let async settle
    process.env.DEXTER_DIR = tmpDir; // restore
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. memory.ts — upsertThesisEntry, market context round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('memory.ts extended', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-memory-ext-${Date.now()}`);
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('upsertThesisEntry creates a new thesis when none exists', async () => {
    const { upsertThesisEntry, loadThesis } = await import('./memory.js');
    await upsertThesisEntry('AAPL', 'Q1 2026 Earnings', 'Beat EPS by $0.08', 'no_action');

    const thesis = await loadThesis('AAPL');
    expect(thesis).not.toBeNull();
    expect(thesis!.ticker).toBe('AAPL');
    expect(thesis!.history.length).toBe(1);
    expect(thesis!.history[0]?.event).toBe('Q1 2026 Earnings');
  });

  test('upsertThesisEntry appends to an existing thesis', async () => {
    const { upsertThesisEntry, loadThesis } = await import('./memory.js');
    await upsertThesisEntry('NVDA', 'Q4 2025', 'Strong beat', 'add');
    await upsertThesisEntry('NVDA', 'Q1 2026', 'Slight miss', 'no_action');

    const thesis = await loadThesis('NVDA');
    expect(thesis!.history.length).toBe(2);
    expect(thesis!.history[0]?.decision).toBe('add');
    expect(thesis!.history[1]?.decision).toBe('no_action');
  });

  test('saveMarketContext and loadMarketContext round-trip', async () => {
    const { saveMarketContext, loadMarketContext } = await import('./memory.js');
    const context = {
      fedRate: 4.5,
      marketSentiment: 'cautious',
      topRisks: ['inflation', 'geopolitical tension'],
    };

    await saveMarketContext(context);
    const loaded = await loadMarketContext();
    expect(loaded).not.toBeNull();
    expect(loaded!['fedRate']).toBe(4.5);
    expect(loaded!['marketSentiment']).toBe('cautious');
    expect(loaded!['updatedAt']).toBeDefined();
  });

  test('loadMarketContext returns null when no file exists', async () => {
    const { loadMarketContext } = await import('./memory.js');
    const result = await loadMarketContext();
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. pipelines.ts — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('pipelines.ts edge cases', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-pipelines-edge-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('loadAllPipelines returns empty array when dir does not exist', async () => {
    const { loadAllPipelines } = await import('./pipelines.js');
    const result = await loadAllPipelines();
    expect(result).toEqual([]);
  });

  test('loadAllPipelines skips non-JSON files', async () => {
    const dir = join(tmpDir, 'pipelines');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'notes.txt'), 'not json', 'utf-8');
    await writeFile(join(dir, '.gitkeep'), '', 'utf-8');

    const { loadAllPipelines } = await import('./pipelines.js');
    const result = await loadAllPipelines();
    expect(result).toEqual([]);
  });

  test('savePipeline sets updatedAt on write', async () => {
    const { createPipeline, loadPipeline } = await import('./pipelines.js');

    const before = new Date().toISOString();
    const p = await createPipeline({
      ticker: 'AAPL',
      eventType: 'earnings',
      description: 'Test',
      eventDate: '2026-07-01',
      collection: { scriptPath: '/tmp/s.ts', scheduleCron: '0 0 31 2 *', outputDataPath: '/tmp/out' },
      processing: { notifyChannel: 'telegram' },
      context: {},
    });

    const loaded = await loadPipeline(p.id);
    expect(loaded!.updatedAt >= before).toBe(true);
  });

  test('createPipeline id includes ticker and eventType', async () => {
    const { createPipeline } = await import('./pipelines.js');
    const p = await createPipeline({
      ticker: 'MSFT',
      eventType: 'ex_dividend',
      description: 'Test',
      eventDate: '2026-07-01',
      collection: { scriptPath: '/tmp/s.ts', scheduleCron: '0 0 31 2 *', outputDataPath: '/tmp/out' },
      processing: { notifyChannel: 'telegram' },
      context: {},
    });

    expect(p.id).toMatch(/^MSFT-ex_dividend-/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. profile.ts — updateProfile, createDefaultProfile
// ─────────────────────────────────────────────────────────────────────────────

describe('profile.ts extended', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-profile-ext-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('createDefaultProfile creates profile with correct delivery settings', async () => {
    const { createDefaultProfile, loadProfile } = await import('./profile.js');
    await createDefaultProfile('Bob', 'telegram', '987654321');

    const profile = await loadProfile();
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe('Bob');
    expect(profile!.delivery.channel).toBe('telegram');
    expect(profile!.delivery.chatId).toBe('987654321');
    expect(profile!.delivery.briefingCron).toBe('0 7 * * 1-5');
    expect(profile!.holdings).toEqual([]);
    expect(profile!.goals).toEqual([]);
  });

  test('updateProfile merges fields without overwriting unrelated ones', async () => {
    const { createDefaultProfile, updateProfile, loadProfile } = await import('./profile.js');
    await createDefaultProfile('Alice', 'telegram', '111');

    await updateProfile({ cash: 99999, riskTolerance: 'aggressive' });

    const updated = await loadProfile();
    expect(updated!.cash).toBe(99999);
    expect(updated!.riskTolerance).toBe('aggressive');
    expect(updated!.name).toBe('Alice'); // untouched
    expect(updated!.delivery.chatId).toBe('111'); // untouched
  });

  test('updateProfile updates updatedAt timestamp', async () => {
    const { createDefaultProfile, updateProfile, loadProfile } = await import('./profile.js');
    await createDefaultProfile('Charlie', 'whatsapp', '+1555');
    const before = (await loadProfile())!.updatedAt;

    await new Promise((r) => setTimeout(r, 5)); // ensure clock advances
    await updateProfile({ cash: 1000 });

    const after = (await loadProfile())!.updatedAt;
    expect(after > before).toBe(true);
  });

  test('buildProfileContext formats cost basis to 2 decimal places', async () => {
    const { buildProfileContext } = await import('./profile.js');
    const profile = {
      name: 'Test',
      timezone: 'UTC',
      currency: 'USD',
      riskTolerance: 'moderate' as const,
      timeHorizon: '10 years',
      goals: [],
      holdings: [{ ticker: 'AAPL', shares: 10, costBasis: 123.456, account: 'taxable' as const }],
      cash: 0,
      watchlist: [],
      constraints: { maxPositionPct: 25, rebalanceThreshold: 0.05 },
      delivery: { channel: 'telegram' as const, chatId: '1', timezone: 'UTC' },
      createdAt: '',
      updatedAt: '',
    };
    const ctx = buildProfileContext(profile);
    expect(ctx).toContain('$123.46'); // rounded to 2dp
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. WakeQueue — briefing_run routing
// ─────────────────────────────────────────────────────────────────────────────

describe('WakeQueue briefing_run', () => {
  test('briefing_run event is pushed and consumed correctly', async () => {
    const q = new WakeQueue();
    q.push({ type: 'briefing_run' });
    const event = await q.next();
    expect(event.type).toBe('briefing_run');
    expect(q.length).toBe(0);
  });

  test('mixed event types drain in FIFO order', async () => {
    const q = new WakeQueue();
    q.push({ type: 'management_run', reason: 'startup' });
    q.push({ type: 'briefing_run' });
    q.push({ type: 'pipeline_complete', pipelineId: 'p1', ticker: 'AAPL', dataPath: '/tmp' });

    const a = await q.next();
    const b = await q.next();
    const c = await q.next();

    expect(a.type).toBe('management_run');
    expect(b.type).toBe('briefing_run');
    expect(c.type).toBe('pipeline_complete');
  });
});
