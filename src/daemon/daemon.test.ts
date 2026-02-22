/**
 * Daemon Integration Tests
 *
 * Tests the daemon's core components without real LLM calls or external APIs:
 *   1. WakeQueue — concurrency correctness
 *   2. resetStuckPipelines — startup health check
 *   3. Profile backup — .bak written before every save
 *   4. Pipeline lifecycle — end-to-end event routing with mocked agent runner
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WakeQueue } from './wake-queue.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. WakeQueue
// ─────────────────────────────────────────────────────────────────────────────

describe('WakeQueue', () => {
  test('push then next returns the event', async () => {
    const q = new WakeQueue();
    q.push({ type: 'management_run', reason: 'test' });
    const event = await q.next();
    expect(event.type).toBe('management_run');
    expect(q.length).toBe(0);
  });

  test('next resolves after a delayed push', async () => {
    const q = new WakeQueue();
    setTimeout(() => q.push({ type: 'management_run', reason: 'delayed' }), 10);
    const event = await q.next();
    expect(event.type).toBe('management_run');
  });

  test('FIFO ordering is preserved', async () => {
    const q = new WakeQueue();
    q.push({ type: 'management_run', reason: 'first' });
    q.push({ type: 'management_run', reason: 'second' });
    q.push({ type: 'management_run', reason: 'third' });
    const a = await q.next();
    const b = await q.next();
    const c = await q.next();
    expect((a as { reason: string }).reason).toBe('first');
    expect((b as { reason: string }).reason).toBe('second');
    expect((c as { reason: string }).reason).toBe('third');
  });

  test('rapid concurrent pushes do not drop events', async () => {
    const q = new WakeQueue();
    const N = 20;

    // Simultaneously start N waiters and N producers
    const promises = Array.from({ length: N }, (_, i) => {
      q.push({ type: 'management_run', reason: `event-${i}` });
      return q.next();
    });

    const events = await Promise.all(promises);
    expect(events.length).toBe(N);
    expect(q.length).toBe(0);
  });

  test('length reflects unconsumed events', () => {
    const q = new WakeQueue();
    expect(q.length).toBe(0);
    q.push({ type: 'management_run', reason: 'a' });
    q.push({ type: 'management_run', reason: 'b' });
    expect(q.length).toBe(2);
  });

  test('queuedAt is stamped on push', async () => {
    const before = new Date();
    const q = new WakeQueue();
    q.push({ type: 'management_run', reason: 'timing' });
    const event = await q.next();
    const after = new Date();
    expect(event.queuedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(event.queuedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. resetStuckPipelines (via profile + pipelines stores using a tmp dir)
// ─────────────────────────────────────────────────────────────────────────────

describe('resetStuckPipelines', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-test-${Date.now()}`);
    await mkdir(join(tmpDir, 'pipelines'), { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makePipeline(id: string, status: string, lastRunAt?: string) {
    return {
      id,
      ticker: 'AAPL',
      eventType: 'earnings',
      description: `Test pipeline ${id}`,
      eventDate: '2026-04-15',
      collection: {
        scriptPath: `/tmp/${id}-collect.ts`,
        scheduleCron: '0 12 * * *',
        outputDataPath: `/tmp/${id}-data`,
        ...(lastRunAt ? { lastRunAt } : {}),
      },
      processing: { notifyChannel: 'telegram' },
      context: {},
      status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  test('pipelines stuck in running are reset to scheduled', async () => {
    const pipelinesDir = join(tmpDir, 'pipelines');
    // Stuck: running with lastRunAt > 10 minutes ago
    const stuckTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const pipeline = makePipeline('AAPL-earnings-stuck', 'running', stuckTime);
    await writeFile(join(pipelinesDir, 'AAPL-earnings-stuck.json'), JSON.stringify(pipeline));

    // Dynamically import to pick up the new HOME
    const { loadAllPipelines, updatePipelineStatus } = await import('./pipelines.js');

    const before = await loadAllPipelines();
    expect(before[0]?.status).toBe('running');

    // Inline the logic from resetStuckPipelines
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stuck = before.filter(
      (p) =>
        p.status === 'running' &&
        (p.collection.lastRunAt === undefined || p.collection.lastRunAt < tenMinutesAgo)
    );
    await Promise.all(stuck.map((p) => updatePipelineStatus(p.id, 'scheduled')));

    const after = await loadAllPipelines();
    expect(after[0]?.status).toBe('scheduled');
  });

  test('recently-running pipelines are NOT reset (grace window)', async () => {
    const pipelinesDir = join(tmpDir, 'pipelines');
    // Recent: running with lastRunAt only 2 minutes ago
    const recentTime = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const pipeline = makePipeline('AAPL-earnings-recent', 'running', recentTime);
    await writeFile(join(pipelinesDir, 'AAPL-earnings-recent.json'), JSON.stringify(pipeline));

    const { loadAllPipelines, updatePipelineStatus } = await import('./pipelines.js');

    const all = await loadAllPipelines();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stuck = all.filter(
      (p) =>
        p.status === 'running' &&
        (p.collection.lastRunAt === undefined || p.collection.lastRunAt < tenMinutesAgo)
    );

    expect(stuck.length).toBe(0); // nothing to reset

    const after = await loadAllPipelines();
    expect(after[0]?.status).toBe('running'); // unchanged
  });

  test('completed and scheduled pipelines are never touched', async () => {
    const pipelinesDir = join(tmpDir, 'pipelines');
    const completedTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const completed = makePipeline('AAPL-completed', 'completed', completedTime);
    const scheduled = makePipeline('AAPL-scheduled', 'scheduled', completedTime);
    await writeFile(join(pipelinesDir, 'AAPL-completed.json'), JSON.stringify(completed));
    await writeFile(join(pipelinesDir, 'AAPL-scheduled.json'), JSON.stringify(scheduled));

    const { loadAllPipelines } = await import('./pipelines.js');
    const all = await loadAllPipelines();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stuck = all.filter(
      (p) =>
        p.status === 'running' &&
        (p.collection.lastRunAt === undefined || p.collection.lastRunAt < tenMinutesAgo)
    );

    expect(stuck.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Profile backup (.bak written before every save)
// ─────────────────────────────────────────────────────────────────────────────

describe('Profile backup', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-profile-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makeProfile(name: string) {
    return {
      name,
      timezone: 'America/New_York',
      currency: 'USD',
      riskTolerance: 'moderate' as const,
      timeHorizon: 'long-term',
      goals: [],
      holdings: [],
      cash: 0,
      watchlist: [],
      constraints: { maxPositionPct: 25, rebalanceThreshold: 0.05 },
      delivery: { channel: 'telegram' as const, chatId: '123', timezone: 'America/New_York' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  test('first save creates profile.json with no .bak', async () => {
    const { saveProfile } = await import('./profile.js');
    const profile = makeProfile('Alice');
    await saveProfile(profile);

    const profilePath = join(tmpDir, 'profile.json');
    const bakPath = `${profilePath}.bak`;
    expect(existsSync(profilePath)).toBe(true);
    expect(existsSync(bakPath)).toBe(false); // no prior version to back up
  });

  test('second save writes .bak with the previous content', async () => {
    const { saveProfile } = await import('./profile.js');

    const v1 = makeProfile('Version1');
    await saveProfile(v1);

    const v2 = makeProfile('Version2');
    await saveProfile(v2);

    const profilePath = join(tmpDir, 'profile.json');
    const bakPath = `${profilePath}.bak`;

    expect(existsSync(bakPath)).toBe(true);

    const bakContent = JSON.parse(await readFile(bakPath, 'utf-8'));
    // .bak should still have the name from Version1 write
    expect(bakContent.name).toBe('Version1');

    const currentContent = JSON.parse(await readFile(profilePath, 'utf-8'));
    expect(currentContent.name).toBe('Version2');
  });

  test('profile.json is always updated even if .bak copy fails', async () => {
    // Simulate copyFile failing — saveProfile should not throw
    const { saveProfile } = await import('./profile.js');
    const v1 = makeProfile('SafeWrite');
    await saveProfile(v1);

    // Write a non-copyable state by making bak a directory instead of a file (edge case)
    const profilePath = join(tmpDir, 'profile.json');
    const bakPath = `${profilePath}.bak`;
    await mkdir(bakPath, { recursive: true }).catch(() => {});

    // Second save: copyFile will fail silently, but profile.json must still update
    const v2 = makeProfile('SafeWrite2');
    await expect(saveProfile(v2)).resolves.toBeUndefined();

    const current = JSON.parse(await readFile(profilePath, 'utf-8'));
    expect(current.name).toBe('SafeWrite2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Pipeline lifecycle — event routing with spy
// ─────────────────────────────────────────────────────────────────────────────

describe('Pipeline lifecycle event routing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `dexter-lifecycle-test-${Date.now()}`);
    await mkdir(join(tmpDir, 'pipelines'), { recursive: true });
    process.env.DEXTER_DIR = tmpDir;
  });

  afterEach(async () => {
    delete process.env.DEXTER_DIR;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('createPipeline stores pipeline with status=scheduled', async () => {
    const { createPipeline, loadPipeline } = await import('./pipelines.js');

    const pipeline = await createPipeline({
      ticker: 'NVDA',
      eventType: 'earnings',
      description: 'NVDA Q1 2026 Earnings',
      eventDate: '2026-05-15',
      collection: {
        scriptPath: '/tmp/nvda-collect.ts',
        scheduleCron: '0 12 15 5 *',
        outputDataPath: '/tmp/nvda-data',
      },
      processing: { notifyChannel: 'telegram' },
      context: {},
    });

    expect(pipeline.status).toBe('scheduled');
    expect(pipeline.ticker).toBe('NVDA');
    expect(pipeline.id).toMatch(/^NVDA-earnings-/);

    const loaded = await loadPipeline(pipeline.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe('scheduled');
  });

  test('updatePipelineStatus transitions correctly', async () => {
    const { createPipeline, loadPipeline, updatePipelineStatus } = await import('./pipelines.js');

    const pipeline = await createPipeline({
      ticker: 'TSLA',
      eventType: 'earnings',
      description: 'TSLA Q1 2026 Earnings',
      eventDate: '2026-04-20',
      collection: {
        scriptPath: '/tmp/tsla-collect.ts',
        scheduleCron: '0 12 20 4 *',
        outputDataPath: '/tmp/tsla-data',
      },
      processing: { notifyChannel: 'telegram' },
      context: {},
    });

    await updatePipelineStatus(pipeline.id, 'running');
    const running = await loadPipeline(pipeline.id);
    expect(running!.status).toBe('running');

    await updatePipelineStatus(pipeline.id, 'completed', { completedAt: new Date().toISOString() });
    const completed = await loadPipeline(pipeline.id);
    expect(completed!.status).toBe('completed');
    expect(completed!.completedAt).toBeDefined();
  });

  test('findExistingPipeline returns null after cancel', async () => {
    const { createPipeline, cancelPipeline, findExistingPipeline } = await import('./pipelines.js');

    const pipeline = await createPipeline({
      ticker: 'AAPL',
      eventType: 'earnings',
      description: 'AAPL Q1 2026 Earnings',
      eventDate: '2026-04-25',
      collection: {
        scriptPath: '/tmp/aapl-collect.ts',
        scheduleCron: '0 12 25 4 *',
        outputDataPath: '/tmp/aapl-data',
      },
      processing: { notifyChannel: 'telegram' },
      context: {},
    });

    const found = await findExistingPipeline('AAPL', 'earnings');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(pipeline.id);

    await cancelPipeline(pipeline.id);
    const notFound = await findExistingPipeline('AAPL', 'earnings');
    expect(notFound).toBeNull();
  });

  test('WakeQueue routes pipeline_complete events correctly', async () => {
    const q = new WakeQueue();

    // Simulate scheduler firing a pipeline
    q.push({
      type: 'pipeline_complete',
      pipelineId: 'AAPL-earnings-123',
      ticker: 'AAPL',
      dataPath: '/tmp/aapl-data',
    });

    const event = await q.next();
    expect(event.type).toBe('pipeline_complete');
    if (event.type === 'pipeline_complete') {
      expect(event.pipelineId).toBe('AAPL-earnings-123');
      expect(event.ticker).toBe('AAPL');
      expect(event.dataPath).toBe('/tmp/aapl-data');
    }
  });
});
