/**
 * Pipeline management tools for the management agent.
 * The agent uses these to create, schedule, and monitor data collection pipelines.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  createPipeline,
  loadAllPipelines,
  loadPipeline,
  cancelPipeline,
  findExistingPipeline,
  updatePipelineStatus,
  type EventType,
  type PipelineCreate,
} from '../../daemon/pipelines.js';

export const createPipelineTool = new DynamicStructuredTool({
  name: 'create_pipeline',
  description: `Create a new data collection pipeline for an upcoming event.
A pipeline defines: what data to collect, when to collect it (cron), and how to process it.
The collection script must already exist and be tested before creating a pipeline.
The pipeline will be automatically scheduled and run by the daemon.`,

  schema: z.object({
    ticker: z.string().describe('Ticker symbol (e.g. AAPL)'),
    eventType: z
      .enum(['earnings', 'ex_dividend', 'analyst_day', 'filing_10k', 'filing_10q', 'filing_8k', 'price_alert', 'custom'])
      .describe('Type of event to monitor'),
    description: z.string().describe('Human-readable description (e.g. "AAPL Q1 2026 Earnings")'),
    eventDate: z.string().describe('Expected event date (ISO format, e.g. 2026-04-30)'),
    scriptFilename: z.string().describe('Collection script filename (must already exist in ~/.dexter/scripts/)'),
    scheduleCron: z
      .string()
      .describe('Cron expression for when to run collection (e.g. "0 21 30 4 *" for April 30 at 9pm)'),
    notifyChannel: z.enum(['telegram', 'whatsapp']).default('telegram'),
    alertThreshold: z
      .string()
      .optional()
      .describe(
        'Natural language condition for sending alert (e.g. "revenue miss >3% OR guidance cut"). If omitted, agent decides.'
      ),
    positionShares: z.number().optional(),
    positionCostBasis: z.number().optional(),
    thesisSnapshot: z.string().optional().describe('Current thesis for this ticker'),
  }),

  func: async ({
    ticker,
    eventType,
    description,
    eventDate,
    scriptFilename,
    scheduleCron,
    notifyChannel,
    alertThreshold,
    positionShares,
    positionCostBasis,
    thesisSnapshot,
  }) => {
    const { getScriptPath } = await import('../../daemon/pipelines.js');
    const { join } = await import('node:path');
    const { getScriptsDir } = await import('../../daemon/pipelines.js');

    const scriptPath = join(getScriptsDir(), scriptFilename.replace(/[^a-zA-Z0-9._-]/g, '-'));

    const def: PipelineCreate = {
      ticker: ticker.toUpperCase(),
      eventType: eventType as EventType,
      description,
      eventDate,
      collection: {
        scriptPath,
        scheduleCron,
      },
      processing: {
        notifyChannel,
        alertThreshold,
      },
      context: {
        position:
          positionShares !== undefined && positionCostBasis !== undefined
            ? { shares: positionShares, costBasis: positionCostBasis }
            : undefined,
        thesis: thesisSnapshot,
      },
    };

    const pipeline = await createPipeline(def);

    return formatToolResult({
      success: true,
      pipelineId: pipeline.id,
      description: pipeline.description,
      scheduleCron: pipeline.collection.scheduleCron,
      eventDate: pipeline.eventDate,
      message: `Pipeline created: ${pipeline.id}. Will collect data on schedule: ${scheduleCron}`,
    });
  },
});

export const listPipelinesTool = new DynamicStructuredTool({
  name: 'list_pipelines',
  description: `List all data collection pipelines (active, completed, and cancelled).
Use this to check what's already being monitored before creating new pipelines.`,
  schema: z.object({
    ticker: z.string().optional().describe('Filter by ticker'),
    status: z
      .enum(['scheduled', 'running', 'completed', 'failed', 'cancelled', 'all'])
      .default('all'),
  }),
  func: async ({ ticker, status }) => {
    const all = await loadAllPipelines();
    const filtered = all.filter(
      (p) =>
        (!ticker || p.ticker === ticker.toUpperCase()) &&
        (status === 'all' || p.status === status)
    );

    const summary = filtered.map((p) => ({
      id: p.id,
      ticker: p.ticker,
      description: p.description,
      eventDate: p.eventDate,
      status: p.status,
      scheduleCron: p.collection.scheduleCron,
      testedAt: p.collection.testedAt,
    }));

    return formatToolResult({ pipelines: summary, count: filtered.length });
  },
});

export const checkPipelineExistsTool = new DynamicStructuredTool({
  name: 'check_pipeline_exists',
  description: `Check if a pipeline already exists for a ticker + event combination.
Use this before creating a new pipeline to avoid duplicates.`,
  schema: z.object({
    ticker: z.string(),
    eventType: z.enum(['earnings', 'ex_dividend', 'analyst_day', 'filing_10k', 'filing_10q', 'filing_8k', 'price_alert', 'custom']),
    description: z.string().optional(),
  }),
  func: async ({ ticker, eventType, description }) => {
    const existing = await findExistingPipeline(ticker.toUpperCase(), eventType as EventType, description);
    return formatToolResult({
      exists: existing !== null,
      pipeline: existing ?? undefined,
      message: existing
        ? `Pipeline already exists: ${existing.id} (${existing.status})`
        : 'No existing pipeline found. Safe to create.',
    });
  },
});

export const cancelPipelineTool = new DynamicStructuredTool({
  name: 'cancel_pipeline',
  description: `Cancel an active pipeline. Use when an event has passed, a position is closed, or the pipeline is no longer needed.`,
  schema: z.object({
    pipelineId: z.string().describe('Pipeline ID to cancel'),
    reason: z.string().optional(),
  }),
  func: async ({ pipelineId, reason }) => {
    await cancelPipeline(pipelineId);
    return formatToolResult({
      success: true,
      pipelineId,
      reason,
      message: `Pipeline ${pipelineId} cancelled.`,
    });
  },
});

export const markPipelineTestedTool = new DynamicStructuredTool({
  name: 'mark_pipeline_tested',
  description: `Mark a pipeline's collection script as tested and verified. Call this after test_script succeeds.`,
  schema: z.object({
    pipelineId: z.string(),
    testResult: z.enum(['success', 'failure']),
  }),
  func: async ({ pipelineId, testResult }) => {
    const pipeline = await loadPipeline(pipelineId);
    if (!pipeline) return formatToolResult({ error: `Pipeline not found: ${pipelineId}` });
    pipeline.collection.testedAt = new Date().toISOString();
    pipeline.collection.testResult = testResult;
    await updatePipelineStatus(pipelineId, pipeline.status, {
      collection: pipeline.collection,
    });
    return formatToolResult({ success: true, pipelineId, testResult });
  },
});
