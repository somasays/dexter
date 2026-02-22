/**
 * Alert delivery tools for the processing agent.
 * These send actionable notifications to the user via their preferred channel.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { loadProfile } from '../../daemon/profile.js';
import { getTelegramChannel, formatForTelegram } from '../../gateway/channels/telegram/plugin.js';
import { sendMessageWhatsApp } from '../../gateway/channels/whatsapp/outbound.js';

async function deliverMessage(
  chatId: string,
  channel: 'telegram' | 'whatsapp',
  text: string
): Promise<void> {
  if (channel === 'telegram') {
    const bot = getTelegramChannel();
    if (!bot) throw new Error('Telegram channel not configured. Set TELEGRAM_BOT_TOKEN in .env');
    const formatted = formatForTelegram(`[Dexter] ${text}`);
    await bot.sendWithRetry({ chatId, text: formatted, parseMode: 'HTML' });
  } else {
    // WhatsApp delivery via baileys gateway session
    // chatId is the E.164 phone number stored in the profile (e.g. "+14155551234")
    await sendMessageWhatsApp({ to: chatId, body: text });
    console.log(`[alert:whatsapp → ${chatId}] message sent`);
  }
}

export const sendAlertTool = new DynamicStructuredTool({
  name: 'send_alert',
  description: `Send an alert/notification to the user via their configured channel (Telegram or WhatsApp).
Use this ONLY when the processing agent has determined that action is needed.
The message should be specific, actionable, and brief (suitable for a messaging app).`,

  schema: z.object({
    message: z
      .string()
      .describe(
        'The alert message to send. Include: what happened (with numbers), thesis impact, specific recommendation, next catalyst.'
      ),
    urgency: z
      .enum(['low', 'medium', 'high'])
      .describe(
        'low = informational, medium = should monitor, high = action recommended soon'
      ),
    ticker: z.string().optional().describe('Primary ticker this alert is about'),
  }),

  func: async ({ message, urgency, ticker }) => {
    const profile = await loadProfile();
    if (!profile) {
      return formatToolResult({ error: 'No profile found — cannot deliver alert.' });
    }

    const prefix = urgency === 'high' ? '🚨' : urgency === 'medium' ? '⚠️' : 'ℹ️';
    const tickerTag = ticker ? ` ${ticker.toUpperCase()}` : '';
    const fullMessage = `${prefix}${tickerTag}: ${message}`;

    try {
      await deliverMessage(profile.delivery.chatId, profile.delivery.channel, fullMessage);
      console.log(`[alert] Delivered ${urgency} alert to ${profile.delivery.channel}:${profile.delivery.chatId}`);
      return formatToolResult({
        success: true,
        channel: profile.delivery.channel,
        urgency,
        message: fullMessage,
        deliveredAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[alert] Delivery failed:', err);
      return formatToolResult({
        success: false,
        error: String(err),
        message: 'Alert could not be delivered. Logged to console.',
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
