/**
 * Scheduler Engine
 *
 * Manages cron-based scheduling for the daemon.
 * The agent creates schedules; this engine executes them.
 */

import { Cron } from 'croner';
import { getActivePipelines, updatePipelineStatus, type Pipeline } from './pipelines.js';

export type ScheduledTaskCallback = (pipeline: Pipeline) => Promise<void>;

export class SchedulerEngine {
  private jobs = new Map<string, Cron>();
  private onFire: ScheduledTaskCallback;

  constructor(onFire: ScheduledTaskCallback) {
    this.onFire = onFire;
  }

  /** Restore all active pipeline schedules from disk (call on daemon start) */
  async restoreSchedules(): Promise<void> {
    const pipelines = await getActivePipelines();
    for (const pipeline of pipelines) {
      this.schedulePipeline(pipeline);
    }
    console.log(`[scheduler] Restored ${pipelines.length} pipeline schedule(s).`);
  }

  /** Schedule a new pipeline */
  schedulePipeline(pipeline: Pipeline): void {
    if (this.jobs.has(pipeline.id)) {
      this.jobs.get(pipeline.id)?.stop();
    }

    try {
      const job = new Cron(
        pipeline.collection.scheduleCron,
        { timezone: 'UTC', protect: true },
        async () => {
          console.log(`[scheduler] Firing pipeline: ${pipeline.id}`);
          try {
            await updatePipelineStatus(pipeline.id, 'running');
            await this.onFire(pipeline);
          } catch (err) {
            console.error(`[scheduler] Pipeline ${pipeline.id} failed:`, err);
            await updatePipelineStatus(pipeline.id, 'failed');
          }
        }
      );
      this.jobs.set(pipeline.id, job);
      console.log(
        `[scheduler] Scheduled pipeline ${pipeline.id}: "${pipeline.description}" at cron ${pipeline.collection.scheduleCron}`
      );
    } catch (err) {
      console.error(`[scheduler] Failed to schedule pipeline ${pipeline.id}:`, err);
    }
  }

  /** Cancel a scheduled job */
  cancelPipeline(pipelineId: string): void {
    const job = this.jobs.get(pipelineId);
    if (job) {
      job.stop();
      this.jobs.delete(pipelineId);
      console.log(`[scheduler] Cancelled pipeline: ${pipelineId}`);
    }
  }

  /** Get next run time for a pipeline */
  getNextRun(pipelineId: string): Date | null {
    const job = this.jobs.get(pipelineId);
    if (!job) return null;
    return job.nextRun() ?? null;
  }

  /** Stop all jobs */
  stopAll(): void {
    for (const [id, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    console.log('[scheduler] All jobs stopped.');
  }

  get activeJobCount(): number {
    return this.jobs.size;
  }
}
