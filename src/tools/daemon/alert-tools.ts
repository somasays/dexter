/**
 * Alert delivery tools for the processing agent.
 * These send actionable notifications to the user via their preferred channel.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatToolResult } from '../types.js';
import { loadProfile } from '../../daemon/profile.js';
import { getDexterDir } from '../../daemon/profile.js';
import { getTelegramChannel } from '../../gateway/channels/telegram/plugin.js';
import { sendMessageWhatsApp } from '../../gateway/channels/whatsapp/outbound.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface StructuredAlert {
  headline: string;
  specifics: string;
  thesisImpact: string;
  recommendation: string;
  nextCatalyst: string;
  urgency: 'low' | 'medium' | 'high';
  ticker: string;
}

interface FailedAlertRecord {
  timestamp: string;
  channel: 'telegram' | 'whatsapp';
  chatId: string;
  alert: StructuredAlert;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

const URGENCY_PREFIX = {
  high: '🚨',
  medium: '⚠️',
  low: 'ℹ️',
} as const;

/** Render a structured alert into a scannable Telegram/WhatsApp message */
function formatAlertMessage(alert: StructuredAlert): string {
  const prefix = URGENCY_PREFIX[alert.urgency];
  return [
    `${prefix} <b>${alert.ticker.toUpperCase()} — ${alert.headline}</b>`,
    ``,
    `<b>What happened:</b> ${alert.specifics}`,
    `<b>Thesis impact:</b> ${alert.thesisImpact}`,
    `<b>Recommendation:</b> ${alert.recommendation}`,
    `<b>Next catalyst:</b> ${alert.nextCatalyst}`,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery
// ─────────────────────────────────────────────────────────────────────────────

async function deliverMessage(
  chatId: string,
  channel: 'telegram' | 'whatsapp',
  text: string
): Promise<void> {
  if (channel === 'telegram') {
    const bot = getTelegramChannel();
    if (!bot) throw new Error('Telegram channel not configured. Set TELEGRAM_BOT_TOKEN in .env');
    await bot.sendWithRetry({ chatId, text, parseMode: 'HTML' });
  } else {
    await sendMessageWhatsApp({ to: chatId, body: text });
    console.log(`[alert:whatsapp → ${chatId}] message sent`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Failed-alert persistence (S2-6)
// ─────────────────────────────────────────────────────────────────────────────

function getFailedAlertsPath(): string {
  return join(getDexterDir(), 'alerts-failed.jsonl');
}

async function writeFailedAlert(record: FailedAlertRecord): Promise<void> {
  try {
    await mkdir(getDexterDir(), { recursive: true });
    await appendFile(getFailedAlertsPath(), JSON.stringify(record) + '\n', 'utf-8');
    console.warn('[alert] Persisted failed alert to alerts-failed.jsonl for retry on next startup');
  } catch (err) {
    console.error('[alert] Could not persist failed alert:', err);
  }
}

/**
 * Called at daemon startup: re-deliver any alerts that failed in a prior session.
 * Successfully re-delivered entries are removed; persistent failures stay for the next run.
 */
export async function retryFailedAlerts(): Promise<void> {
  const path = getFailedAlertsPath();
  if (!existsSync(path)) return;

  const raw = await readFile(path, 'utf-8').catch(() => '');
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length === 0) return;

  console.log(`[alert] Retrying ${lines.length} failed alert(s) from previous session...`);

  const remaining: string[] = [];
  for (const line of lines) {
    let record: FailedAlertRecord;
    try {
      record = JSON.parse(line) as FailedAlertRecord;
    } catch {
      continue; // discard malformed entries
    }

    try {
      const text = formatAlertMessage(record.alert);
      await deliverMessage(record.chatId, record.channel, text);
      console.log(`[alert] Retried and delivered failed alert for ${record.alert.ticker}`);
    } catch (err) {
      console.error('[alert] Retry still failed:', err);
      remaining.push(line);
    }
  }

  // Rewrite file with only the still-failing entries
  await writeFile(path, remaining.join('\n') + (remaining.length > 0 ? '\n' : ''), 'utf-8').catch(
    () => {}
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

export const sendAlertTool = new DynamicStructuredTool({
  name: 'send_alert',
  description: `Send a structured alert to the user via their configured channel (Telegram or WhatsApp).
Use this ONLY when the processing agent has determined that action is needed.
Every field is required — be specific and include exact numbers.`,

  schema: z.object({
    ticker: z.string().describe('Primary ticker this alert is about (e.g. "AAPL")'),
    headline: z
      .string()
      .describe(
        'One-line summary with exact numbers. E.g. "Q2 Miss: Services +11.2% vs +14.8% est"'
      ),
    specifics: z
      .string()
      .describe(
        'Key metrics with exact values and vs-estimate deltas. E.g. "EPS $1.52 vs $1.54 est (-1.3%). Revenue $89.5B vs $90.0B est. Services +11.2% vs +14.8% est."'
      ),
    thesisImpact: z
      .string()
      .describe(
        'How this event changes the investment thesis. E.g. "Services growth deceleration challenges the premium multiple thesis."'
      ),
    recommendation: z
      .string()
      .describe(
        'Specific, actionable recommendation with quantity where possible. E.g. "Trim 15-20% (sell ~20 shares at current price). Stop-loss at $175."'
      ),
    nextCatalyst: z
      .string()
      .describe('The next event to watch. E.g. "WWDC June 9 — Services pricing announcement."'),
    urgency: z
      .enum(['low', 'medium', 'high'])
      .describe('low = informational, medium = monitor closely, high = action recommended soon'),
  }),

  func: async ({ ticker, headline, specifics, thesisImpact, recommendation, nextCatalyst, urgency }) => {
    const profile = await loadProfile();
    if (!profile) {
      return formatToolResult({ error: 'No profile found — cannot deliver alert.' });
    }

    const alert: StructuredAlert = {
      ticker,
      headline,
      specifics,
      thesisImpact,
      recommendation,
      nextCatalyst,
      urgency,
    };

    const text = formatAlertMessage(alert);

    try {
      await deliverMessage(profile.delivery.chatId, profile.delivery.channel, text);
      console.log(`[alert] Delivered ${urgency} alert for ${ticker} to ${profile.delivery.channel}:${profile.delivery.chatId}`);
      return formatToolResult({
        success: true,
        channel: profile.delivery.channel,
        urgency,
        ticker,
        deliveredAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[alert] Delivery failed:', err);
      await writeFailedAlert({
        timestamp: new Date().toISOString(),
        channel: profile.delivery.channel,
        chatId: profile.delivery.chatId,
        alert,
      });
      return formatToolResult({
        success: false,
        error: String(err),
        message: 'Alert delivery failed. Persisted to alerts-failed.jsonl for retry on next startup.',
      });
    }
  },
});

export const sendReplyTool = new DynamicStructuredTool({
  name: 'send_reply',
  description: `Send a reply to the user in response to their message.
Use this in the reactive agent to deliver the response to the user's query.`,

  schema: z.object({
    message: z.string().describe('Response message to send'),
    chatId: z.string().optional().describe('Override chat ID (defaults to profile delivery chatId)'),
    channel: z.enum(['telegram', 'whatsapp']).optional(),
  }),

  func: async ({ message, chatId, channel }) => {
    const profile = await loadProfile();
    const targetChatId = chatId ?? profile?.delivery.chatId;
    const targetChannel = channel ?? profile?.delivery.channel ?? 'telegram';

    if (!targetChatId) {
      return formatToolResult({ error: 'No chat ID available for reply.' });
    }

    try {
      await deliverMessage(targetChatId, targetChannel, message);
      return formatToolResult({ success: true, deliveredAt: new Date().toISOString() });
    } catch (err) {
      return formatToolResult({ success: false, error: String(err) });
    }
  },
});
