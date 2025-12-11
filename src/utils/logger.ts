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
      const formattedData = this.formatData(data);
      if (formattedData) {
        console.log(`${COLORS.dim}${formattedData}${COLORS.reset}`);
      }
    }
  }

  private formatData(data: unknown): string {
    // Handle Error objects specially
    if (data instanceof Error) {
      return `${data.name}: ${data.message}${data.stack ? `\n${data.stack}` : ''}`;
    }

    // Handle objects that might be API errors
    if (typeof data === 'object' && data !== null) {
      const errorObj = data as Record<string, unknown>;

      // Check for common error properties
      if ('message' in errorObj || 'error' in errorObj || 'status' in errorObj) {
        const parts: string[] = [];
        if ('status' in errorObj) parts.push(`Status: ${errorObj.status}`);
        if ('message' in errorObj) parts.push(`Message: ${errorObj.message}`);
        if ('error' in errorObj && typeof errorObj.error === 'object') {
          const nestedError = errorObj.error as Record<string, unknown>;
          if ('message' in nestedError) parts.push(`Error: ${nestedError.message}`);
        }
        if (parts.length > 0) {
          return parts.join(', ');
        }
      }

      // Try to stringify, with fallback
      try {
        const jsonStr = JSON.stringify(data, null, 2);
        // Don't print empty objects
        if (jsonStr === '{}') {
          return 'Empty error object - possible API error with no enumerable properties';
        }
        return jsonStr;
      } catch {
        return `[Object: ${Object.prototype.toString.call(data)}]`;
      }
    }

    return String(data);
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
