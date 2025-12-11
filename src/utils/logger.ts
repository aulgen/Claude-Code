/**
 * Logging utility for the FAQ Content Generator
 */

import { getConfig } from './config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function getColor(level: LogLevel): string {
  switch (level) {
    case 'debug':
      return COLORS.gray;
    case 'info':
      return COLORS.blue;
    case 'warn':
      return COLORS.yellow;
    case 'error':
      return COLORS.red;
    default:
      return COLORS.white;
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function shouldLog(level: LogLevel): boolean {
  try {
    const config = getConfig();
    return LOG_LEVELS[level] >= LOG_LEVELS[config.logging.level];
  } catch {
    // Default to info level if config is not available
    return LOG_LEVELS[level] >= LOG_LEVELS.info;
  }
}

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!shouldLog(level)) return;

    const timestamp = formatTimestamp();
    const color = getColor(level);
    const levelStr = level.toUpperCase().padEnd(5);

    const prefix = `${COLORS.dim}${timestamp}${COLORS.reset} ${color}${levelStr}${COLORS.reset} ${COLORS.cyan}[${this.context}]${COLORS.reset}`;

    console.log(`${prefix} ${message}`);

    if (data !== undefined) {
      if (typeof data === 'object') {
        console.log(`${COLORS.dim}${JSON.stringify(data, null, 2)}${COLORS.reset}`);
      } else {
        console.log(`${COLORS.dim}${data}${COLORS.reset}`);
      }
    }
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  // Progress indicator for long-running operations
  progress(stage: string, current: number, total: number, message?: string): void {
    const percentage = Math.round((current / total) * 100);
    const bar = this.createProgressBar(percentage);
    const msg = message ? ` - ${message}` : '';
    this.info(`${stage} ${bar} ${percentage}%${msg}`);
  }

  private createProgressBar(percentage: number): string {
    const width = 20;
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;
    return `[${COLORS.green}${'█'.repeat(filled)}${COLORS.dim}${'░'.repeat(empty)}${COLORS.reset}]`;
  }

  // Section divider for better readability
  section(title: string): void {
    const line = '─'.repeat(50);
    console.log(`\n${COLORS.cyan}${line}${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.cyan}  ${title}${COLORS.reset}`);
    console.log(`${COLORS.cyan}${line}${COLORS.reset}\n`);
  }

  // Success message with checkmark
  success(message: string): void {
    console.log(`${COLORS.green}✓${COLORS.reset} ${message}`);
  }

  // Failure message with x
  failure(message: string): void {
    console.log(`${COLORS.red}✗${COLORS.reset} ${message}`);
  }
}

// Factory function for creating loggers
export function createLogger(context: string): Logger {
  return new Logger(context);
}

// Default logger instance
export const logger = createLogger('App');
