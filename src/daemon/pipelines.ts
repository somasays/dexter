/**
 * Pipeline Store
 *
 * Manages data collection pipelines that the agent creates autonomously.
 * Each pipeline: monitors an event → runs a collection script → processes results → alerts if needed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDexterDir } from './profile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export type EventType =
  | 'earnings'
  | 'ex_dividend'
  | 'analyst_day'
  | 'filing_10k'
  | 'filing_10q'
  | 'filing_8k'
  | 'price_alert'
  | 'custom';

export type PipelineStatus = 'scheduled' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Pipeline {
  id: string;
  ticker: string;
  eventType: EventType;
  description: string; // human-readable, e.g. "AAPL Q1 2026 Earnings"
  eventDate: string; // ISO date when event is expected

  collection: {
    scriptPath: string; // ~/.dexter/scripts/{id}-collect.ts
    scheduleCron: string; // when to run the collection script
    testedAt?: string; // when the script was last tested successfully
    testResult?: 'success' | 'failure';
    lastRunAt?: string;
  };

  processing: {
    model?: string; // override model for this pipeline
    notifyChannel: 'telegram' | 'whatsapp';
    alertThreshold?: string; // natural language condition for alerting
  };

  context: {
    position?: { shares: number; costBasis: number };
    thesis?: string; // snapshot of thesis at pipeline creation time
    additionalContext?: string;
  };

  status: PipelineStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  collectedDataPath?: string; // where the raw data was written
}

export type PipelineCreate = Omit<Pipeline, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

export function getPipelinesDir(): string {
  return join(getDexterDir(), 'pipelines');
}

export function getScriptsDir(): string {
  return join(getDexterDir(), 'scripts');
}

export function getCollectedDataDir(): string {
  return join(getDexterDir(), 'collected');
}

export function getPipelinePath(id: string): string {
  return join(getPipelinesDir(), `${id}.json`);
}

export function getScriptPath(pipelineId: string): string {
  return join(getScriptsDir(), `${pipelineId}-collect.ts`);
}

export function getCollectedDataPath(ticker: string, eventType: string, period: string): string {
  return join(getCollectedDataDir(), ticker.toUpperCase(), eventType, period);
}

async function ensureDirs(): Promise<void> {
  await mkdir(getPipelinesDir(), { recursive: true });
  await mkdir(getScriptsDir(), { recursive: true });
  await mkdir(getCollectedDataDir(), { recursive: true });
}

export async function loadPipeline(id: string): Promise<Pipeline | null> {
  const path = getPipelinePath(id);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as Pipeline;
}

export async function savePipeline(pipeline: Pipeline): Promise<void> {
  await ensureDirs();
  pipeline.updatedAt = new Date().toISOString();
  await writeFile(getPipelinePath(pipeline.id), JSON.stringify(pipeline, null, 2), 'utf-8');
}

export async function loadAllPipelines(): Promise<Pipeline[]> {
  if (!existsSync(getPipelinesDir())) return [];
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(getPipelinesDir());
  const pipelines: Pipeline[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const raw = await readFile(join(getPipelinesDir(), file), 'utf-8');
    pipelines.push(JSON.parse(raw) as Pipeline);
  }
  return pipelines;
}

export async function createPipeline(def: PipelineCreate): Promise<Pipeline> {
  const id = `${def.ticker.toUpperCase()}-${def.eventType}-${Date.now()}`;
  const pipeline: Pipeline = {
    ...def,
    id,
    status: 'scheduled',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await savePipeline(pipeline);
  return pipeline;
}

export async function updatePipelineStatus(
  id: string,
  status: PipelineStatus,
  extra?: Partial<Pipeline>
): Promise<void> {
  const pipeline = await loadPipeline(id);
  if (!pipeline) throw new Error(`Pipeline not found: ${id}`);
  await savePipeline({ ...pipeline, ...extra, status });
}

export async function cancelPipeline(id: string): Promise<void> {
  await updatePipelineStatus(id, 'cancelled');
}

/** Get all active (non-cancelled, non-completed) pipelines for scheduling */
export async function getActivePipelines(): Promise<Pipeline[]> {
  const all = await loadAllPipelines();
  return all.filter((p) => p.status === 'scheduled' || p.status === 'running');
}

/** Check if a pipeline already exists for a given ticker + event */
export async function findExistingPipeline(
  ticker: string,
  eventType: EventType,
  description?: string
): Promise<Pipeline | null> {
  const all = await loadAllPipelines();
  return (
    all.find(
      (p) =>
        p.ticker.toUpperCase() === ticker.toUpperCase() &&
        p.eventType === eventType &&
        p.status !== 'cancelled' &&
        p.status !== 'completed' &&
        (description === undefined || p.description === description)
    ) ?? null
  );
}
