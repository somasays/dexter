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
import { stat, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SchedulerEngine } from './scheduler.js';
import { loadProfile, getDexterDir, type FinancialProfile } from './profile.js';
import { updatePipelineStatus, loadAllPipelines, type Pipeline } from './pipelines.js';
import {
  buildManagementAgentPrompt,
  buildProcessingAgentPrompt,
  buildReactiveAgentPrompt,
  buildBriefingAgentPrompt,
  type WakeReason,
} from './prompts.js';
import { getTelegramChannel } from '../gateway/channels/telegram/plugin.js';
import { runDaemonAgent } from './agent-runner.js';
import { WakeQueue, type WakeEvent } from './wake-queue.js';
import { retryFailedAlerts } from '../tools/daemon/alert-tools.js';
import { daemonLog } from '../utils/daemon-logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// Daemon
// ─────────────────────────────────────────────────────────────────────────────

export class WealthAgentDaemon {
  private wakeQueue = new WakeQueue();
  private scheduler: SchedulerEngine;
  private managementCron?: Cron;
  private briefingCron?: Cron;
  private telegramChannel = getTelegramChannel();
  private running = false;
  /** Cache profile at start so Telegram auth check works even before first event */
  private cachedProfile: FinancialProfile | null = null;

  constructor() {
    this.scheduler = new SchedulerEngine((pipeline) => this.onPipelineFired(pipeline));
  }

  async start(): Promise<void> {
    this.running = true;
    daemonLog.info('daemon', 'Dexter daemon starting');
    console.log('[daemon] Starting Dexter autonomous wealth agent...');

    this.cachedProfile = await loadProfile();
    if (!this.cachedProfile) {
      console.warn('[daemon] No profile found. Run: bun run daemon:setup');
      console.log('[daemon] Running without profile context. Some features disabled.');
    } else {
      console.log(`[daemon] Profile loaded for: ${this.cachedProfile.name}`);
    }

    // Validate a usable LLM model is configured
    const model = process.env.DEXTER_DAEMON_MODEL;
    if (!model) {
      console.warn('[daemon] DEXTER_DAEMON_MODEL is not set. Defaulting to gpt-4o.');
      console.warn('[daemon] Set DEXTER_DAEMON_MODEL in .env to use a specific model.');
    }

    // Restore pipeline schedules from disk
    await this.scheduler.restoreSchedules();

    // Reset any pipelines that were left in `running` state from a prior crash.
    // A pipeline stuck in `running` for > 10 minutes indicates an unclean shutdown.
    await this.resetStuckPipelines();

    // Start Telegram if configured
    if (this.telegramChannel) {
      const authorizedChatId = this.cachedProfile?.delivery.chatId;

      this.telegramChannel.onInbound((msg) => {
        // Security: reject messages from any sender that isn't the configured chatId.
        // When authorizedChatId is undefined (no profile), ALL messages are rejected —
        // the user must run daemon:setup before Telegram access is permitted.
        if (!authorizedChatId || msg.chatId !== authorizedChatId) {
          console.warn(`[daemon] Rejected message from unauthorized sender: ${msg.chatId}`);
          return;
        }
        console.log(`[daemon] Inbound message from ${msg.from}: ${msg.text.slice(0, 50)}...`);
        this.wakeQueue.push({
          type: 'message',
          channel: 'telegram',
          from: msg.chatId, // use chatId (not username) for reliable reply routing
          text: msg.text,
        });
      });
      await this.telegramChannel.start();
    } else {
      console.log('[daemon] Telegram not configured (TELEGRAM_BOT_TOKEN not set).');
    }

    // Retry any alerts that failed to deliver in a prior session
    await retryFailedAlerts().catch((err) =>
      console.error('[daemon] Failed alert retry error:', err)
    );

    // Schedule daily management run (6am UTC)
    this.managementCron = new Cron('0 6 * * *', { timezone: 'UTC' }, () => {
      this.wakeQueue.push({ type: 'management_run', reason: 'Daily management cycle' });
    });
    console.log('[daemon] Management agent scheduled: daily at 6am UTC');

    // Schedule morning briefing if configured in profile
    const briefingCron = this.cachedProfile?.delivery.briefingCron;
    if (briefingCron) {
      this.briefingCron = new Cron(briefingCron, { timezone: 'UTC' }, () => {
        this.wakeQueue.push({ type: 'briefing_run' });
      });
      console.log(`[daemon] Morning briefing scheduled: ${briefingCron}`);
    }

    // Preflight check — print clear summary before entering event loop
    await this.runPreflightCheck();

    // Initial management run on startup (idempotent — management agent checks existing pipelines)
    console.log('[daemon] Triggering initial management run...');
    this.wakeQueue.push({ type: 'management_run', reason: 'Startup management cycle' });

    daemonLog.info('daemon', 'Daemon event loop starting');
    // Main event loop
    await this.runEventLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.managementCron?.stop();
    this.briefingCron?.stop();
    this.scheduler.stopAll();
    await this.telegramChannel?.stop();
    daemonLog.info('daemon', 'Daemon stopped');
    console.log('[daemon] Daemon stopped.');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Startup health checks
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Any pipeline left in `running` status is a crash artifact — the prior
   * process died while the collection script was executing.  Reset these to
   * `scheduled` so the next management run can decide whether to rerun them.
   * A 10-minute grace window avoids racing with a daemon that just started.
   */
  private async resetStuckPipelines(): Promise<void> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const all = await loadAllPipelines();
    const stuck = all.filter(
      (p) =>
        p.status === 'running' &&
        (p.collection.lastRunAt === undefined || p.collection.lastRunAt < tenMinutesAgo)
    );
    if (stuck.length === 0) return;
    console.warn(`[daemon] Resetting ${stuck.length} stuck pipeline(s) to 'scheduled':`, stuck.map((p) => p.id));
    await Promise.all(stuck.map((p) => updatePipelineStatus(p.id, 'scheduled')));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Preflight
  // ─────────────────────────────────────────────────────────────────────────

  private async runPreflightCheck(): Promise<void> {
    const profile = this.cachedProfile;
    const model = process.env.DEXTER_DAEMON_MODEL ?? 'gpt-4o';
    const hasTelegram = !!process.env.TELEGRAM_BOT_TOKEN;
    const hasFinancial = !!process.env.FINANCIAL_DATASETS_API_KEY;
    const hasExa = !!process.env.EXASEARCH_API_KEY;
    const hasTavily = !!process.env.TAVILY_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasLlm = hasOpenAI || hasAnthropic;

    const activePipelines = await loadAllPipelines().then(
      (ps) => ps.filter((p) => p.status === 'scheduled' || p.status === 'running').length
    ).catch(() => 0);

    const webSearch = hasExa ? 'Exa' : hasTavily ? 'Tavily' : 'NOT CONFIGURED';
    const llmProvider = hasOpenAI ? `OpenAI (${model})` : hasAnthropic ? `Anthropic (${model})` : 'NOT CONFIGURED';

    console.log('\n[daemon] Preflight check:');
    console.log(`  Profile:          ${profile ? `FOUND (${profile.name}, ${profile.holdings.length} holdings)` : 'NOT FOUND — run daemon:setup'}`);
    console.log(`  Telegram:         ${hasTelegram ? 'CONFIGURED' : 'NOT CONFIGURED (set TELEGRAM_BOT_TOKEN)'}`);
    console.log(`  LLM provider:     ${llmProvider}`);
    console.log(`  Financial data:   ${hasFinancial ? 'CONFIGURED (FINANCIAL_DATASETS_API_KEY set)' : 'NOT CONFIGURED (set FINANCIAL_DATASETS_API_KEY)'}`);
    console.log(`  Web search:       ${webSearch}`);
    console.log(`  Active pipelines: ${activePipelines} scheduled`);

    if (!hasLlm) {
      const msg = 'No LLM API key configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env';
      console.error(`\n[daemon] FATAL: ${msg}`);
      daemonLog.error('daemon', msg);
      process.exit(1);
    }

    if (!hasTelegram) {
      console.warn('[daemon] WARNING: Telegram not configured — alerts cannot be delivered');
    }
    if (!hasFinancial) {
      console.warn('[daemon] WARNING: Financial data API not configured — collection scripts may fail');
    }

    console.log('[daemon] Preflight complete. Starting event loop.\n');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event loop
  // ─────────────────────────────────────────────────────────────────────────

  private async runEventLoop(): Promise<void> {
    while (this.running) {
      try {
        const event = await this.wakeQueue.next();
        console.log(`[daemon] Processing event: ${event.type} (queue depth: ${this.wakeQueue.length})`);

        // Reactive messages run concurrently — don't block management/processing
        if (event.type === 'message') {
          // Reload profile to pick up any recent changes before responding
          const profile = await this.safeLoadProfile();
          this.runReactiveAgent(profile, event).catch((err) =>
            console.error('[daemon] Reactive agent error:', err)
          );
        } else {
          await this.handleEvent(event);
        }
      } catch (err) {
        console.error('[daemon] Error in event loop:', err);
        daemonLog.error('daemon', 'Event loop error', { error: String(err) });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async handleEvent(event: WakeEvent): Promise<void> {
    const profile = await this.safeLoadProfile();

    switch (event.type) {
      case 'management_run':
        await this.runManagementAgent(profile);
        break;

      case 'pipeline_complete':
        await this.runProcessingAgent(profile, event.pipelineId, event.ticker, event.dataPath);
        break;

      case 'scheduled':
        await this.runManagementAgent(profile);
        break;

      case 'briefing_run':
        await this.runBriefingAgent(profile);
        break;

      case 'message':
        // Should be handled in runEventLoop, not here
        break;
    }
  }

  /** Load profile with basic error handling to avoid infinite crash loops */
  private async safeLoadProfile(): Promise<FinancialProfile | null> {
    try {
      const profile = await loadProfile();
      if (profile) this.cachedProfile = profile;
      return profile;
    } catch (err) {
      console.error('[daemon] Failed to load profile (using cached):', err);
      return this.cachedProfile;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Agent runners
  // ─────────────────────────────────────────────────────────────────────────

  private async writeLastManagementRun(): Promise<void> {
    try {
      const dir = getDexterDir();
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'daemon-state.json'),
        JSON.stringify({ lastManagementRunAt: new Date().toISOString() }, null, 2),
        'utf-8'
      );
    } catch {/* non-fatal */}
  }

  private async runManagementAgent(profile: FinancialProfile | null): Promise<void> {
    if (!profile) {
      console.log('[daemon] Skipping management agent — no profile configured.');
      return;
    }
    console.log('[daemon] Running management agent...');
    const systemPrompt = buildManagementAgentPrompt(profile);
    const query = `Run the daily management cycle for ${profile.name}'s portfolio. Discover upcoming events, check existing pipelines, create new pipelines where needed, and ensure thesis notes exist for all holdings.`;

    daemonLog.info('management', 'Management run starting', { profile: profile.name });
    await runDaemonAgent({ query, systemPrompt, agentType: 'management', scheduler: this.scheduler });
    await this.writeLastManagementRun();
    daemonLog.info('management', 'Management run complete');
    console.log('[daemon] Management agent complete.');
  }

  private async runBriefingAgent(profile: FinancialProfile | null): Promise<void> {
    if (!profile) {
      console.log('[daemon] Skipping briefing agent — no profile configured.');
      return;
    }
    console.log('[daemon] Running morning briefing agent...');
    const systemPrompt = buildBriefingAgentPrompt(profile);
    const query = `Deliver the morning briefing to ${profile.name}.`;
    await runDaemonAgent({ query, systemPrompt, agentType: 'reactive', replyTo: {
      channel: profile.delivery.channel,
      chatId: profile.delivery.chatId,
    }});
    console.log('[daemon] Morning briefing delivered.');
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
    daemonLog.info('processing', 'Processing agent starting', { pipelineId, ticker });
    const systemPrompt = buildProcessingAgentPrompt(profile, pipelineId, ticker, dataPath);
    const query = `Process the collected data for ${ticker} pipeline ${pipelineId}. The data is at: ${dataPath}. Analyze and decide: ALERT or NO_ACTION.`;

    await runDaemonAgent({ query, systemPrompt, agentType: 'processing' });

    await updatePipelineStatus(pipelineId, 'completed', {
      completedAt: new Date().toISOString(),
      collectedDataPath: dataPath,
    });
    daemonLog.info('processing', 'Processing agent complete', { pipelineId, ticker });
    console.log(`[daemon] Processing agent complete for ${pipelineId}.`);
  }

  private async runReactiveAgent(
    profile: FinancialProfile | null,
    event: Extract<WakeReason, { type: 'message' }>
  ): Promise<void> {
    if (!profile) {
      if (this.telegramChannel && event.channel === 'telegram') {
        await this.telegramChannel.send({
          chatId: event.from,
          text: "Hi! I'm Dexter. Run `bun run daemon:setup` to configure your profile.",
        });
      }
      return;
    }

    console.log(`[daemon] Running reactive agent for: "${event.text.slice(0, 60)}"`);
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
    daemonLog.info('pipeline', 'Pipeline fired', { pipelineId: pipeline.id, ticker: pipeline.ticker, description: pipeline.description });

    // Use the canonical output path stored in the pipeline definition
    const dataPath = pipeline.collection.outputDataPath;

    const { getCollectedDataDir } = await import('./pipelines.js');
    const proc = Bun.spawn(['bun', 'run', '--smol', pipeline.collection.scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        HOME: process.env.HOME!,
        PATH: process.env.PATH!,
        FINANCIAL_DATASETS_API_KEY: process.env.FINANCIAL_DATASETS_API_KEY ?? '',
        EXASEARCH_API_KEY: process.env.EXASEARCH_API_KEY ?? '',
        // Give the script the exact output path it must write to
        DEXTER_OUTPUT_PATH: dataPath,
        DEXTER_COLLECTED_DIR: getCollectedDataDir(),
      },
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { proc.kill(); } catch { /* already exited */ }
    }, 120_000);

    let stdoutText = '';
    const [exitCode] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().then((out) => {
        stdoutText = out;
        if (out) console.log(`[pipeline:${pipeline.id}] stdout: ${out.slice(0, 500)}`);
      }),
      new Response(proc.stderr).text().then((err) => {
        if (err) console.error(`[pipeline:${pipeline.id}] stderr: ${err.slice(0, 300)}`);
      }),
    ]);
    clearTimeout(timeout);

    if (timedOut || exitCode !== 0) {
      const reason = timedOut ? 'timeout (120s)' : `exit code ${exitCode}`;
      console.error(`[daemon] Pipeline script failed (${reason}): ${pipeline.id}`);
      daemonLog.error('pipeline', 'Pipeline collection failed', { pipelineId: pipeline.id, ticker: pipeline.ticker, reason });
      await updatePipelineStatus(pipeline.id, 'failed');
      // Notify user that collection failed — they deserve to know
      const profile = await this.safeLoadProfile();
      if (profile && this.telegramChannel) {
        await this.telegramChannel.send({
          chatId: profile.delivery.chatId,
          text: `⚠️ Pipeline collection failed for ${pipeline.description} (${reason}). Will not have analysis for this event.`,
        }).catch(() => {/* non-fatal */});
      }
      return;
    }

    // Fix 4: Verify data was actually written before queuing processing
    const dataExists = await this.verifyDataWritten(dataPath);
    if (!dataExists) {
      console.error(`[daemon] Pipeline script exited 0 but wrote no data to ${dataPath}: ${pipeline.id}`);
      await updatePipelineStatus(pipeline.id, 'failed');
      const profile = await this.safeLoadProfile();
      if (profile && this.telegramChannel) {
        await this.telegramChannel.send({
          chatId: profile.delivery.chatId,
          text: `⚠️ ${pipeline.description}: data collection script ran but produced no output. Possible API issue. Will retry next cycle.`,
        }).catch(() => {/* non-fatal */});
      }
      return;
    }

    console.log(`[daemon] Data collected at ${dataPath}. Queuing processing.`);
    daemonLog.info('pipeline', 'Pipeline collection complete — queuing processing', { pipelineId: pipeline.id, ticker: pipeline.ticker, dataPath });
    this.wakeQueue.push({
      type: 'pipeline_complete',
      pipelineId: pipeline.id,
      ticker: pipeline.ticker,
      dataPath,
    });
  }

  /** Check that at least one file with content exists in the output directory */
  private async verifyDataWritten(dirPath: string): Promise<boolean> {
    try {
      const files = await readdir(dirPath);
      for (const file of files) {
        const s = await stat(join(dirPath, file));
        if (s.isFile() && s.size > 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
