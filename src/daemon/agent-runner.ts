/**
 * Daemon Agent Runner
 *
 * Runs an agent in headless (non-interactive) mode with daemon-specific tools.
 * Used by the management, processing, and reactive agent roles.
 */

import { callLlm } from '../model/llm.js';
import { buildIterationPrompt, buildFinalAnswerPrompt } from '../agent/prompts.js';
import { estimateTokens, CONTEXT_THRESHOLD, KEEP_TOOL_USES } from '../utils/tokens.js';
import { hasToolCalls, extractTextContent } from '../utils/ai-message.js';
import { createRunContext } from '../agent/run-context.js';
import { buildFinalAnswerContext } from '../agent/final-answer-context.js';
import { AgentToolExecutor } from '../agent/tool-executor.js';
import { getDaemonTools } from './tools.js';
import { daemonLog } from '../utils/daemon-logger.js';
import type { SchedulerEngine } from './scheduler.js';

// Daemon always auto-approves file tools (headless, no interactive prompt)
const DAEMON_PRE_APPROVED = new Set(['write_file', 'edit_file', 'write_script']);

export interface DaemonAgentConfig {
  query: string;
  systemPrompt: string;
  agentType: 'management' | 'processing' | 'reactive';
  scheduler?: SchedulerEngine;
  replyTo?: { channel: 'telegram' | 'whatsapp'; chatId: string };
  model?: string;
  maxIterations?: number;
}

const DEFAULT_MODEL = process.env.DEXTER_DAEMON_MODEL ?? 'gpt-5.2';
const DEFAULT_MAX_ITERATIONS = 15;

export async function runDaemonAgent(config: DaemonAgentConfig): Promise<string> {
  const {
    query,
    systemPrompt,
    agentType,
    scheduler,
    replyTo,
    model = DEFAULT_MODEL,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = config;

  // Get daemon-specific tools (profile, memory, pipeline, code execution, alerts)
  const tools = getDaemonTools({ agentType, scheduler });
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  // Daemon runs headlessly — auto-approve file tools
  const toolExecutor = new AgentToolExecutor(toolMap, undefined, undefined, DAEMON_PRE_APPROVED);

  const ctx = createRunContext(query);
  let currentPrompt = query;

  console.log(`[agent:${agentType}] Starting with ${tools.length} tools, max ${maxIterations} iterations`);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    ctx.iteration = iteration + 1;

    const { response, usage } = await callLlm(currentPrompt, {
      model,
      systemPrompt,
      tools,
    }).catch((err) => {
      console.error(`[agent:${agentType}] LLM call failed:`, err);
      throw err;
    });

    if (usage) ctx.tokenCounter.add(usage);

    const responseText = typeof response === 'string' ? response : extractTextContent(response);

    // No tool calls — we're done
    if (typeof response === 'string' || !hasToolCalls(response)) {
      if (!ctx.scratchpad.hasToolResults() && responseText) {
        console.log(`[agent:${agentType}] Direct response (no tools needed)`);
        return responseText ?? '';
      }

      // Generate final answer
      const fullContext = buildFinalAnswerContext(ctx.scratchpad);
      const finalPrompt = buildFinalAnswerPrompt(query, fullContext);
      const { response: finalResponse } = await callLlm(finalPrompt, {
        model,
        systemPrompt,
      });
      const answer = typeof finalResponse === 'string'
        ? finalResponse
        : extractTextContent(finalResponse);

      const usage = ctx.tokenCounter.getUsage();
      console.log(`[agent:${agentType}] Complete after ${ctx.iteration} iterations (${usage?.inputTokens ?? 0} in / ${usage?.outputTokens ?? 0} out tokens)`);
      daemonLog.info(`agent:${agentType}`, 'Agent run complete', {
        iterations: ctx.iteration,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
      });
      return answer ?? '';
    }

    // Execute tools
    for await (const event of toolExecutor.executeAll(response, ctx)) {
      if (event.type === 'tool_start') {
        console.log(`[agent:${agentType}] Tool: ${event.tool}`);
      }
      if (event.type === 'tool_end') {
        console.log(`[agent:${agentType}] Tool complete: ${event.tool}`);
      }
      if (event.type === 'tool_denied') {
        console.warn(`[agent:${agentType}] Tool denied: ${event.tool}`);
      }
    }

    // Context management
    const estimatedTokens = estimateTokens(
      systemPrompt + query + ctx.scratchpad.getToolResults()
    );
    if (estimatedTokens > CONTEXT_THRESHOLD) {
      const cleared = ctx.scratchpad.clearOldestToolResults(KEEP_TOOL_USES);
      if (cleared > 0) {
        console.log(`[agent:${agentType}] Context cleared ${cleared} old tool results`);
      }
    }

    currentPrompt = buildIterationPrompt(
      query,
      ctx.scratchpad.getToolResults(),
      ctx.scratchpad.formatToolUsageForPrompt()
    );
  }

  // Max iterations — generate best-effort answer
  const fullContext = buildFinalAnswerContext(ctx.scratchpad);
  const finalPrompt = buildFinalAnswerPrompt(query, fullContext);
  const { response: finalResponse } = await callLlm(finalPrompt, { model, systemPrompt });
  const answer = typeof finalResponse === 'string'
    ? finalResponse
    : extractTextContent(finalResponse);
  const usage = ctx.tokenCounter.getUsage();
  console.log(`[agent:${agentType}] Max iterations reached (${maxIterations}). Tokens: ${usage?.inputTokens ?? 0} in / ${usage?.outputTokens ?? 0} out`);
  daemonLog.warn(`agent:${agentType}`, 'Agent hit max iterations', {
    maxIterations,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  });
  return answer ?? '';
}
