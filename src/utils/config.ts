/**
 * Configuration management for the FAQ Content Generator
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Load environment variables
dotenv.config();

export interface AppConfig {
  anthropic: {
    apiKey: string;
    model: string;
  };
  google: {
    credentialsPath: string;
    folderId?: string;
  };
  search: {
    provider: 'duckduckgo' | 'serpapi' | 'none';
    serpApiKey?: string;
  };
  output: {
    dir: string;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
  };
}

function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value && defaultValue === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value || defaultValue || '';
}

function getEnvVarOptional(key: string): string | undefined {
  return process.env[key] || undefined;
}

export function loadConfig(): AppConfig {
  // Determine search provider based on available API keys
  const serpApiKey = getEnvVarOptional('SERPAPI_KEY');
  let searchProvider: AppConfig['search']['provider'] = 'duckduckgo';
  if (serpApiKey) {
    searchProvider = 'serpapi';
  } else if (getEnvVarOptional('DISABLE_WEB_SEARCH') === 'true') {
    searchProvider = 'none';
  }

  return {
    anthropic: {
      apiKey: getEnvVar('ANTHROPIC_API_KEY'),
      model: getEnvVar('CLAUDE_MODEL', 'claude-opus-4-5-20251101'),
    },
    google: {
      credentialsPath: getEnvVar('GOOGLE_CREDENTIALS_PATH', './credentials.json'),
      folderId: getEnvVarOptional('GOOGLE_DRIVE_FOLDER_ID'),
    },
    search: {
      provider: searchProvider,
      serpApiKey,
    },
    output: {
      dir: getEnvVar('OUTPUT_DIR', './output'),
    },
    logging: {
      level: (getEnvVar('LOG_LEVEL', 'info') as AppConfig['logging']['level']),
    },
  };
}

export function ensureOutputDirectory(config: AppConfig): void {
  const outputPath = path.resolve(config.output.dir);
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }
}

export function validateConfig(config: AppConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.anthropic.apiKey) {
    errors.push('ANTHROPIC_API_KEY is required');
  }

  // Check if Google credentials file exists (only if Google Docs integration is needed)
  const credPath = path.resolve(config.google.credentialsPath);
  if (config.google.credentialsPath && !fs.existsSync(credPath)) {
    // This is a warning, not an error - Google Docs is optional
    console.warn(`Warning: Google credentials file not found at ${credPath}. Google Docs integration will be disabled.`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Singleton config instance
let configInstance: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

export function resetConfig(): void {
  configInstance = null;
}
