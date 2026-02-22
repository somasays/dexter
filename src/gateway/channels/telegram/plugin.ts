/**
 * Telegram Gateway Channel Plugin
 *
 * Uses grammy (TypeScript-native Telegram Bot API wrapper) to:
 * - Receive messages from the user
 * - Send alerts and responses back
 *
 * Setup: Create a bot via @BotFather, set TELEGRAM_BOT_TOKEN in .env
 * Find your chat ID by messaging @userinfobot or via /start with your bot
 */

import { Bot, type Context } from 'grammy';

export type TelegramMessage = {
  chatId: string;
  from: string;
  text: string;
  timestamp: Date;
};

export type TelegramSend = {
  chatId: string;
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
};

export class TelegramChannel {
  private bot: Bot;
  private onMessage?: (msg: TelegramMessage) => void;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  /** Register a handler for inbound messages */
  onInbound(handler: (msg: TelegramMessage) => void): void {
    this.onMessage = handler;

    this.bot.on('message:text', (ctx: Context) => {
      if (!ctx.message?.text || !ctx.chat) return;
      handler({
        chatId: String(ctx.chat.id),
        from: ctx.from?.username ?? String(ctx.from?.id ?? 'unknown'),
        text: ctx.message.text,
        timestamp: new Date(ctx.message.date * 1000),
      });
    });
  }

  /** Start polling for messages */
  async start(): Promise<void> {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.log('[telegram] TELEGRAM_BOT_TOKEN not set, channel disabled.');
      return;
    }
    console.log('[telegram] Starting bot polling...');
    // Start in background (non-blocking)
    this.bot.start({
      onStart: () => console.log('[telegram] Bot started — listening for messages.'),
    }).catch((err) => {
      console.error('[telegram] Bot error:', err);
    });
  }

  /** Stop the bot */
  async stop(): Promise<void> {
    await this.bot.stop();
    console.log('[telegram] Bot stopped.');
  }

  /** Send a message to a specific chat */
  async send({ chatId, text, parseMode }: TelegramSend): Promise<void> {
    if (!process.env.TELEGRAM_BOT_TOKEN) return;
    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: parseMode,
      });
    } catch (err) {
      console.error(`[telegram] Failed to send message to ${chatId}:`, err);
      throw err;
    }
  }

  /** Send a message with retry on rate limit */
  async sendWithRetry(params: TelegramSend, retries = 3): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.send(params);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < retries && msg.includes('429')) {
          // Rate limited — wait and retry
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw err;
      }
    }
  }
}

/** Format a Dexter response for Telegram (clean markdown) */
export function formatForTelegram(text: string): string {
  // Remove markdown headers (##) since Telegram doesn't render them nicely
  // Keep bold (**) and convert to HTML-safe format
  return text
    .replace(/^#{1,3}\s+/gm, '') // Remove headers
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') // Bold
    .trim();
}

/** Singleton channel instance */
let _channel: TelegramChannel | null = null;

export function getTelegramChannel(): TelegramChannel | null {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  if (!_channel) {
    _channel = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN);
  }
  return _channel;
}
