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

import { WealthAgentDaemon } from './daemon.js';
import { runSetupWizard } from './setup.js';
import { loadProfile, buildProfileContext } from './profile.js';
import { loadAllPipelines } from './pipelines.js';

async function printStatus(): Promise<void> {
  const profile = await loadProfile();
  const pipelines = await loadAllPipelines();

  console.log('\n══════════════════════════════════════════');
  console.log('  Dexter Daemon Status');
  console.log('══════════════════════════════════════════\n');

  if (!profile) {
    console.log('Profile: NOT CONFIGURED');
    console.log('Run: bun run dexter daemon setup\n');
    return;
  }

  console.log(buildProfileContext(profile));

  const active = pipelines.filter((p) => p.status === 'scheduled' || p.status === 'running');
  const completed = pipelines.filter((p) => p.status === 'completed');
  const failed = pipelines.filter((p) => p.status === 'failed');

  console.log(`\n── Pipelines ──`);
  console.log(`Active: ${active.length}`);
  for (const p of active) {
    console.log(`  [${p.status}] ${p.description} (${p.collection.scheduleCron})`);
  }
  console.log(`Completed: ${completed.length} | Failed: ${failed.length}\n`);
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
