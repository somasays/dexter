#!/usr/bin/env bun
/**
 * Dexter Daemon Entry Point
 *
 * Usage:
 *   bun run dexter daemon          # Start the autonomous agent daemon
 *   bun run dexter daemon setup    # Run interactive setup wizard
 *   bun run dexter daemon status   # Show current daemon status
 *
 * The daemon:
 *   1. Runs a daily management agent that discovers events and creates monitoring pipelines
 *   2. Executes collection scripts on schedule and runs the processing agent on results
 *   3. Responds to inbound Telegram/WhatsApp messages with portfolio-aware context
 *   4. Only alerts you when action is genuinely needed
 */

import { Cron } from 'croner';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WealthAgentDaemon } from './daemon.js';
import { runSetupWizard } from './setup.js';
import { loadProfile, buildProfileContext, getDexterDir } from './profile.js';
import { loadAllPipelines } from './pipelines.js';
import { listThesisTickers } from './memory.js';

async function getNextCronRun(cronExpr: string): Promise<string> {
  try {
    const job = new Cron(cronExpr, { paused: true });
    const next = job.nextRun();
    job.stop();
    if (!next) return 'never';
    return next.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '(invalid cron)';
  }
}

async function readDaemonState(): Promise<{ lastManagementRunAt?: string }> {
  try {
    const raw = await readFile(join(getDexterDir(), 'daemon-state.json'), 'utf-8');
    return JSON.parse(raw) as { lastManagementRunAt?: string };
  } catch {
    return {};
  }
}

async function printStatus(): Promise<void> {
  const [profile, pipelines, state] = await Promise.all([
    loadProfile(),
    loadAllPipelines(),
    readDaemonState(),
  ]);

  console.log('\n══════════════════════════════════════════');
  console.log('  Dexter Daemon Status');
  console.log('══════════════════════════════════════════\n');

  if (!profile) {
    console.log('Profile: NOT CONFIGURED');
    console.log('Run: bun run dexter daemon setup\n');
    return;
  }

  console.log(buildProfileContext(profile));

  // ── Telegram status ──
  const telegramConfigured = !!process.env.TELEGRAM_BOT_TOKEN;
  console.log(`\n── Channels ──`);
  console.log(`Telegram: ${telegramConfigured ? 'CONFIGURED' : 'NOT CONFIGURED (set TELEGRAM_BOT_TOKEN)'}`);
  console.log(`Delivery channel: ${profile.delivery.channel} → ${profile.delivery.chatId}`);
  if (profile.delivery.briefingCron) {
    const nextBriefing = await getNextCronRun(profile.delivery.briefingCron);
    console.log(`Morning briefing: ${profile.delivery.briefingCron} (next: ${nextBriefing})`);
  } else {
    console.log(`Morning briefing: not configured`);
  }

  // ── Last management run ──
  console.log(`\n── Management ──`);
  if (state.lastManagementRunAt) {
    const d = new Date(state.lastManagementRunAt);
    console.log(`Last management run: ${d.toLocaleString()}`);
  } else {
    console.log(`Last management run: never (daemon has not run yet)`);
  }

  // ── Pipelines ──
  const active = pipelines.filter((p) => p.status === 'scheduled' || p.status === 'running');
  const completed = pipelines.filter((p) => p.status === 'completed');
  const failed = pipelines.filter((p) => p.status === 'failed');

  console.log(`\n── Pipelines ──`);
  console.log(`Active: ${active.length}  |  Completed: ${completed.length}  |  Failed: ${failed.length}`);
  for (const p of active) {
    const nextRun = await getNextCronRun(p.collection.scheduleCron);
    console.log(`  [${p.status.padEnd(9)}] ${p.description}`);
    console.log(`             cron: ${p.collection.scheduleCron}  →  next: ${nextRun}`);
  }
  if (failed.length > 0) {
    console.log(`\nFailed pipelines (need management review):`);
    for (const p of failed) {
      console.log(`  [failed] ${p.description} (last run: ${p.collection.lastRunAt ?? 'unknown'})`);
    }
  }

  // ── Thesis coverage ──
  const thesisTickers = new Set(await listThesisTickers());
  const holdingTickers = profile.holdings.map((h) => h.ticker.toUpperCase());
  const withThesis = holdingTickers.filter((t) => thesisTickers.has(t));
  const withoutThesis = holdingTickers.filter((t) => !thesisTickers.has(t));

  console.log(`\n── Thesis Coverage ──`);
  console.log(`Holdings with thesis: ${withThesis.length} / ${holdingTickers.length}`);
  if (withoutThesis.length > 0) {
    console.log(`Missing thesis: ${withoutThesis.join(', ')} (management agent will write these)`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'run';

  if (command === 'setup') {
    await runSetupWizard();
    return;
  }

  if (command === 'status') {
    await printStatus();
    return;
  }

  // Default: run the daemon
  const daemon = new WealthAgentDaemon();

  const shutdown = async () => {
    console.log('\n[daemon] Shutting down...');
    await daemon.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  try {
    await daemon.start();
  } catch (err) {
    console.error('[daemon] Fatal error:', err);
    process.exit(1);
  }
}

void main();
