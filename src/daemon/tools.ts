/**
 * Tool registry for daemon agents.
 *
 * Each agent type gets a specific set of tools appropriate for its role:
 *  - management: profile, memory, pipeline, code (write+test), financial search, web
 *  - processing: profile, memory, code (read), alert delivery, financial search
 *  - reactive:   profile, memory, financial search, web, file system, alert/reply
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { getToolRegistry } from '../tools/registry.js';
import { readProfileTool, updateProfileTool, addHoldingTool, removeHoldingTool, addGoalTool } from '../tools/daemon/profile-tools.js';
import { readThesisTool, writeThesisTool, appendThesisEntryTool, logActionTool, readActionLogTool, saveMarketContextTool, readMarketContextTool, listMemoryTool } from '../tools/daemon/memory-tools.js';
import { makeCreatePipelineTool, listPipelinesTool, checkPipelineExistsTool, cancelPipelineTool, markPipelineTestedTool } from '../tools/daemon/pipeline-tools.js';
import { writeScriptTool, testScriptTool, runScriptTool, readCollectedDataTool } from '../tools/code/execute-script.js';
import { sendAlertTool, sendReplyTool } from '../tools/daemon/alert-tools.js';
import type { SchedulerEngine } from './scheduler.js';

interface DaemonToolsConfig {
  agentType: 'management' | 'processing' | 'reactive';
  scheduler?: SchedulerEngine;
}

export function getDaemonTools(config: DaemonToolsConfig): StructuredToolInterface[] {
  const { agentType } = config;

  // Base financial tools from the existing registry
  const model = process.env.DEXTER_DAEMON_MODEL ?? 'gpt-4o';
  const baseRegistry = getToolRegistry(model);
  const financialSearch = baseRegistry.find((t) => t.name === 'financial_search')?.tool;
  const financialMetrics = baseRegistry.find((t) => t.name === 'financial_metrics')?.tool;
  const webSearch = baseRegistry.find((t) => t.name === 'web_search')?.tool;
  const webFetch = baseRegistry.find((t) => t.name === 'web_fetch')?.tool;
  const readFilings = baseRegistry.find((t) => t.name === 'read_filings')?.tool;
  const readFile = baseRegistry.find((t) => t.name === 'read_file')?.tool;
  const skillTool = baseRegistry.find((t) => t.name === 'skill')?.tool;

  // Profile tools (shared across all agent types)
  const profileTools = [
    readProfileTool,
    updateProfileTool,
    addHoldingTool,
    removeHoldingTool,
    addGoalTool,
  ];

  // Memory tools
  const memoryTools = [
    readThesisTool,
    writeThesisTool,
    appendThesisEntryTool,
    logActionTool,
    readActionLogTool,
    readMarketContextTool,
    listMemoryTool,
  ];

  if (agentType === 'management') {
    const tools: StructuredToolInterface[] = [
      ...profileTools,
      ...memoryTools,
      saveMarketContextTool,
      // Pipeline management — factory wires new pipelines into live scheduler
      makeCreatePipelineTool(config.scheduler),
      listPipelinesTool,
      checkPipelineExistsTool,
      cancelPipelineTool,
      markPipelineTestedTool,
      // Code execution
      writeScriptTool,
      testScriptTool,
    ];

    // Add financial and web tools if available
    if (financialSearch) tools.push(financialSearch);
    if (financialMetrics) tools.push(financialMetrics);
    if (webSearch) tools.push(webSearch);
    if (webFetch) tools.push(webFetch);
    if (readFilings) tools.push(readFilings);
    if (skillTool) tools.push(skillTool);

    return tools;
  }

  if (agentType === 'processing') {
    const tools: StructuredToolInterface[] = [
      ...profileTools,
      ...memoryTools,
      // Data access
      readCollectedDataTool,
      // Alert delivery
      sendAlertTool,
    ];

    // Processing agent can also fetch fresh data for context
    if (financialSearch) tools.push(financialSearch);
    if (financialMetrics) tools.push(financialMetrics);
    if (webSearch) tools.push(webSearch);

    return tools;
  }

  // reactive
  const tools: StructuredToolInterface[] = [
    ...profileTools,
    ...memoryTools,
    saveMarketContextTool,
    // Reply to user
    sendReplyTool,
    // Pipeline management (user may ask to monitor something)
    makeCreatePipelineTool(config.scheduler),
    listPipelinesTool,
    cancelPipelineTool,
    // Code execution for ad-hoc calculations
    writeScriptTool,
    testScriptTool,
    runScriptTool,
    readCollectedDataTool,
  ];

  if (financialSearch) tools.push(financialSearch);
  if (financialMetrics) tools.push(financialMetrics);
  if (webSearch) tools.push(webSearch);
  if (webFetch) tools.push(webFetch);
  if (readFilings) tools.push(readFilings);
  if (readFile) tools.push(readFile);
  if (skillTool) tools.push(skillTool);

  return tools;
}
