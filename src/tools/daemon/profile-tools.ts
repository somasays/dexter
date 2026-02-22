/**
 * Profile management tools for the agent.
 * These allow the agent to read and update the user's financial profile.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import {
  loadProfile,
  updateProfile,
  addHolding,
  removeHolding,
  buildProfileContext,
  type Holding,
  type FinancialGoal,
} from '../../daemon/profile.js';

export const readProfileTool = new DynamicStructuredTool({
  name: 'read_profile',
  description: `Read the user's complete financial profile including portfolio holdings, goals, risk tolerance, and delivery preferences.
Always call this at the start of any portfolio-related task to get current position data.`,
  schema: z.object({}),
  func: async () => {
    const profile = await loadProfile();
    if (!profile) {
      return formatToolResult({
        error: 'No profile found. The user needs to run setup first.',
        setupCommand: 'bun run dexter daemon setup',
      });
    }
    return formatToolResult({
      profile,
      context: buildProfileContext(profile),
    });
  },
});

export const updateProfileTool = new DynamicStructuredTool({
  name: 'update_profile',
  description: `Update fields in the user's financial profile. Use this to record new information about the user's situation, update their goals, or modify delivery preferences.`,
  schema: z.object({
    riskTolerance: z
      .enum(['conservative', 'moderate', 'moderate-aggressive', 'aggressive'])
      .optional(),
    timeHorizon: z.string().optional(),
    investmentPhilosophy: z.string().optional(),
    cash: z.number().optional(),
    watchlist: z.array(z.string()).optional(),
  }),
  func: async (updates) => {
    const profile = await updateProfile(updates);
    return formatToolResult({ success: true, updatedFields: Object.keys(updates), profile });
  },
});

export const addHoldingTool = new DynamicStructuredTool({
  name: 'add_holding',
  description: `Add or update a holding in the user's portfolio. Use this when the user reports buying a stock or when a position changes.`,
  schema: z.object({
    ticker: z.string().describe('Stock ticker symbol (e.g. AAPL)'),
    shares: z.number().describe('Number of shares held'),
    costBasis: z.number().describe('Average cost per share in USD'),
    account: z
      .enum(['taxable', 'IRA', 'Roth IRA', '401k', 'other'])
      .default('taxable'),
    notes: z.string().optional().describe('Any notes about this position'),
  }),
  func: async ({ ticker, shares, costBasis, account, notes }) => {
    const holding: Holding = { ticker: ticker.toUpperCase(), shares, costBasis, account, notes };
    const profile = await addHolding(holding);
    return formatToolResult({
      success: true,
      holding,
      message: `Added ${shares} shares of ${ticker.toUpperCase()} at $${costBasis}/share to ${account} account.`,
    });
  },
});

export const removeHoldingTool = new DynamicStructuredTool({
  name: 'remove_holding',
  description: `Remove a holding from the portfolio (when position is closed/sold).`,
  schema: z.object({
    ticker: z.string().describe('Ticker symbol to remove'),
  }),
  func: async ({ ticker }) => {
    const profile = await removeHolding(ticker.toUpperCase());
    return formatToolResult({
      success: true,
      message: `Removed ${ticker.toUpperCase()} from portfolio.`,
    });
  },
});

export const addGoalTool = new DynamicStructuredTool({
  name: 'add_goal',
  description: `Add a financial goal to the user's profile.`,
  schema: z.object({
    id: z.string().describe('Unique ID for the goal (e.g. "retirement", "house-downpayment")'),
    description: z.string(),
    targetAmount: z.number(),
    targetDate: z.string().describe('ISO date (e.g. "2038-01-01")'),
    priority: z.enum(['primary', 'secondary']).default('secondary'),
  }),
  func: async ({ id, description, targetAmount, targetDate, priority }) => {
    const profile = await loadProfile();
    if (!profile) return formatToolResult({ error: 'No profile found.' });
    const goal: FinancialGoal = { id, description, targetAmount, targetDate, priority };
    const existing = profile.goals.findIndex((g) => g.id === id);
    if (existing >= 0) {
      profile.goals[existing] = goal;
    } else {
      profile.goals.push(goal);
    }
    await updateProfile({ goals: profile.goals });
    return formatToolResult({ success: true, goal });
  },
});
