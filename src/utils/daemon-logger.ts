/**
 * Structured daemon logger.
 *
 * Writes newline-delimited JSON to ~/.dexter/daemon.log.
 * Rotation: when the file exceeds LOG_MAX_BYTES (10MB), the current log is
 * renamed to daemon.log.1 (overwriting any previous backup) and a fresh
 * daemon.log is started.
 *
 * Each entry: { timestamp, level, component, message, data? }
 */

import { appendFile, rename, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDexterDir } from '../daemon/profile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface DaemonLogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB

function getLogPath(): string {
  return join(getDexterDir(), 'daemon.log');
}

function getLogRotatedPath(): string {
  return join(getDexterDir(), 'daemon.log.1');
}

async function rotateLogs(): Promise<void> {
  const path = getLogPath();
  try {
    const s = await stat(path);
    if (s.size >= LOG_MAX_BYTES) {
      await rename(path, getLogRotatedPath());
    }
  } catch {
    // File doesn't exist yet — nothing to rotate
  }
}

async function writeEntry(entry: DaemonLogEntry): Promise<void> {
  try {
    const dir = getDexterDir();
    await mkdir(dir, { recursive: true });
    await rotateLogs();
    await appendFile(getLogPath(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    // Logging is best-effort — never throw from the logger
  }
}

class DaemonLogger {
  private log(
    level: LogLevel,
    component: string,
    message: string,
    data?: Record<string, unknown>
  ): void {
    const entry: DaemonLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...(data ? { data } : {}),
    };

    // Fire-and-forget — we never await logging to avoid blocking critical paths
    writeEntry(entry).catch(() => {});
  }

  info(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', component, message, data);
  }

  warn(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', component, message, data);
  }

  error(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('error', component, message, data);
  }

  debug(component: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', component, message, data);
  }
}

/** Singleton daemon logger */
export const daemonLog = new DaemonLogger();
