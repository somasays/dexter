/**
 * Dexter Daemon
 *
 * The always-on autonomous wealth agent.
 * Manages the lifecycle of:
 *   - Management agent (daily pipeline discovery and creation)
 *   - Pipeline runner (executes collection scripts on schedule)
 *   - Processing agent (analyzes collected data, decides whether to alert)
 *   - Reactive agent (responds to inbound Telegram/WhatsApp messages)
 */

import { Cron } from 'croner';
import { SchedulerEngine } from './scheduler.js';
import { loadProfile, type FinancialProfile } from './profile.js';
import { updatePipelineStatus, type Pipeline, getCollectedDataPath } from './pipelines.js';
import {
  buildManagementAgentPrompt,
  buildProcessingAgentPrompt,
  buildReactiveAgentPrompt,
  type WakeReason,
} from './prompts.js';
import { getTelegramChannel } from '../gateway/channels/telegram/plugin.js';
import { runDaemonAgent } from './agent-runner.js';

// ─────────────────────────────────────────────────────────────────────────────
// Wake Event Queue
// ─────────────────────────────────────────────────────────────────────────────

type WakeEvent = WakeReason & { queuedAt: Date };

class WakeQueue {
  private queue: WakeEvent[] = [];
  private resolver?: () => void;

  push(event: WakeReason): void {
    this.queue.push({ ...event, queuedAt: new Date() });
    this.resolver?.();
    this.resolver = undefined;
  }

  async next(): Promise<WakeEvent> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    // Wait for an event to arrive
    await new Promise<void>((resolve) => {
      this.resolver = resolve;
    });
    return this.queue.shift()!;
  }

  get length(): number {
    return this.queue.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Daemon
// ─────────────────────────────────────────────────────────────────────────────

export class WealthAgentDaemon {
  private wakeQueue = new WakeQueue();
  private scheduler: SchedulerEngine;
  private managementCron?: Cron;
  private telegramChannel = getTelegramChannel();
  private running = false;

  constructor() {
    this.scheduler = new SchedulerEngine((pipeline) => this.onPipelineFired(pipeline));
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[daemon] Starting Dexter autonomous wealth agent...');

    const profile = await loadProfile();
    if (!profile) {
      console.warn('[daemon] No profile found. Run: bun run dexter daemon setup');
      console.log('[daemon] Running without profile context. Some features disabled.');
    } else {
      console.log(`[daemon] Profile loaded for: ${profile.name}`);
    }

    // Restore pipeline schedules from disk
    await this.scheduler.restoreSchedules();

    // Start Telegram if configured
    if (this.telegramChannel) {
      this.telegramChannel.onInbound((msg) => {
        console.log(`[daemon] Inbound message from ${msg.from}: ${msg.text.slice(0, 50)}...`);
        this.wakeQueue.push({
          type: 'message',
          channel: 'telegram',
          from: msg.from,
          text: msg.text,
        });
      });
      await this.telegramChannel.start();
    } else {
      console.log('[daemon] Telegram not configured (TELEGRAM_BOT_TOKEN not set). Set it in .env to enable.');
    }

    // Schedule daily management run (6am UTC by default)
    const managementCron = profile?.delivery?.briefingCron
      ? '0 6 * * *' // Always run management at 6am UTC regardless of briefing time
      : '0 6 * * *';

    this.managementCron = new Cron(managementCron, { timezone: 'UTC' }, () => {
      this.wakeQueue.push({ type: 'management_run', reason: 'Daily management cycle' });
    });
    console.log('[daemon] Management agent scheduled: daily at 6am UTC');

    // Trigger an initial management run on startup
    console.log('[daemon] Triggering initial management run...');
    this.wakeQueue.push({ type: 'management_run', reason: 'Startup management cycle' });

    // Main event loop
    await this.runEventLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.managementCron?.stop();
    this.scheduler.stopAll();
    await this.telegramChannel?.stop();
    console.log('[daemon] Daemon stopped.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event loop
  // ─────────────────────────────────────────────────────────────────────────

  private async runEventLoop(): Promise<void> {
    while (this.running) {
      try {
        const event = await this.wakeQueue.next();
        console.log(`[daemon] Processing event: ${event.type}`);
        await this.handleEvent(event);
      } catch (err) {
        console.error('[daemon] Error in event loop:', err);
        // Continue running despite errors
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async handleEvent(event: WakeEvent): Promise<void> {
    const profile = await loadProfile();

    switch (event.type) {
      case 'management_run':
        await this.runManagementAgent(profile);
        break;

      case 'pipeline_complete':
        await this.runProcessingAgent(
          profile,
          event.pipelineId,
          event.ticker,
          event.dataPath
        );
        break;

      case 'message':
        await this.runReactiveAgent(profile, event);
        break;

      case 'scheduled':
        // Generic scheduled event — trigger management run
        await this.runManagementAgent(profile);
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent runners
  // ─────────────────────────────────────────────────────────────────────────

  private async runManagementAgent(profile: FinancialProfile | null): Promise<void> {
    if (!profile) {
      console.log('[daemon] Skipping management agent — no profile configured.');
      return;
    }
    console.log('[daemon] Running management agent...');
    const systemPrompt = buildManagementAgentPrompt(profile);
    const query = `Run the daily management cycle for ${profile.name}'s portfolio. Discover upcoming events, check existing pipelines, create new pipelines where needed, and ensure thesis notes exist for all holdings.`;

    await runDaemonAgent({ query, systemPrompt, agentType: 'management', scheduler: this.scheduler });
    console.log('[daemon] Management agent complete.');
  }

  private async runProcessingAgent(
    profile: FinancialProfile | null,
    pipelineId: string,
    ticker: string,
    dataPath: string
  ): Promise<void> {
    if (!profile) {
      console.log('[daemon] Skipping processing agent — no profile configured.');
      return;
    }
    console.log(`[daemon] Running processing agent for pipeline: ${pipelineId}`);
    const systemPrompt = buildProcessingAgentPrompt(profile, pipelineId, ticker, dataPath);
    const query = `Process the collected data for ${ticker} pipeline ${pipelineId}. Analyze the event data and decide: ALERT or NO_ACTION.`;

    await runDaemonAgent({ query, systemPrompt, agentType: 'processing' });

    await updatePipelineStatus(pipelineId, 'completed', {
      completedAt: new Date().toISOString(),
      collectedDataPath: dataPath,
    });
    console.log(`[daemon] Processing agent complete for ${pipelineId}.`);
  }

  private async runReactiveAgent(
    profile: FinancialProfile | null,
    event: Extract<WakeReason, { type: 'message' }>
  ): Promise<void> {
    if (!profile) {
      // Respond without context
      if (this.telegramChannel && event.channel === 'telegram') {
        await this.telegramChannel.send({
          chatId: event.from,
          text: "Hi! I'm Dexter, your autonomous financial agent. Please run setup to configure your profile: bun run dexter daemon setup",
        });
      }
      return;
    }

    console.log(`[daemon] Running reactive agent for message: "${event.text.slice(0, 50)}..."`);
    const systemPrompt = buildReactiveAgentPrompt(profile, event);
    await runDaemonAgent({
      query: event.text,
      systemPrompt,
      agentType: 'reactive',
      replyTo: {
        channel: event.channel as 'telegram' | 'whatsapp',
        chatId: event.from,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pipeline execution (called by scheduler when a pipeline fires)
  // ─────────────────────────────────────────────────────────────────────────

  private async onPipelineFired(pipeline: Pipeline): Promise<void> {
    console.log(`[daemon] Pipeline fired: ${pipeline.id} (${pipeline.description})`);

    // Run the collection script
    const { Bun } = globalThis as { Bun: typeof import('bun') };
    const proc = Bun.spawn(['bun', 'run', pipeline.collection.scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        HOME: process.env.HOME!,
        PATH: process.env.PATH!,
        FINANCIAL_DATASETS_API_KEY: process.env.FINANCIAL_DATASETS_API_KEY ?? '',
        DEXTER_COLLECTED_DIR: (await import('./pipelines.js')).getCollectedDataDir(),
        DEXTER_OUTPUT_DIR: `${process.env.HOME}/.dexter/output`,
      },
    });

    const timeout = setTimeout(() => proc.kill(), 120_000); // 2 min timeout

    const [exitCode] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().then((out) => {
        if (out) console.log(`[pipeline:${pipeline.id}] stdout: ${out.slice(0, 500)}`);
      }),
      new Response(proc.stderr).text().then((err) => {
        if (err) console.error(`[pipeline:${pipeline.id}] stderr: ${err.slice(0, 200)}`);
      }),
    ]);
    clearTimeout(timeout);

    if (exitCode !== 0) {
      console.error(`[daemon] Pipeline collection script failed (exit ${exitCode}): ${pipeline.id}`);
      await updatePipelineStatus(pipeline.id, 'failed');
      return;
    }

    // Data collected — trigger processing agent
    const dataPath = getCollectedDataPath(pipeline.ticker, pipeline.eventType, pipeline.description);
    this.wakeQueue.push({
      type: 'pipeline_complete',
      pipelineId: pipeline.id,
      ticker: pipeline.ticker,
      dataPath,
    });
  }
}
