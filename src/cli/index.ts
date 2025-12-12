/**
 * CLI Interface for FAQ Content Generator
 *
 * Provides an interactive command-line interface for generating FAQ content.
 */

import { Command } from 'commander';
import * as readline from 'readline';
import { createFAQOrchestrator } from '../orchestrator';
import { OrchestratorInput, OrchestratorOptions } from '../types';
import { createLogger } from '../utils/logger';
import { isValidUrl, formatDuration } from '../utils/helpers';
import { loadConfig, validateConfig } from '../utils/config';

const logger = createLogger('CLI');

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
};

function printBanner(): void {
  console.log(`
${COLORS.cyan}╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   ${COLORS.bright}FAQ Content Generator${COLORS.reset}${COLORS.cyan}                                    ║
║   ${COLORS.dim}Multi-Agent System for FAQ Creation & Fact-Checking${COLORS.reset}${COLORS.cyan}       ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);
}

function printHelp(): void {
  console.log(`
${COLORS.bright}Usage:${COLORS.reset}
  npm run dev -- generate <url> [options]
  npm run dev -- interactive

${COLORS.bright}Commands:${COLORS.reset}
  generate <url>    Generate FAQ content for a website URL
  interactive       Start interactive mode

${COLORS.bright}Options:${COLORS.reset}
  -p, --personas <number>     Number of personas to generate (default: 5)
  -f, --faqs <number>         Max FAQs per category (default: 5)
  -o, --output <dir>          Output directory (default: ./output)
  -c, --country <code>        Country for SerpAPI searches (default: us)
  --no-google-docs            Skip Google Docs creation
  --skip-fact-check           Skip fact-checking step
  -h, --help                  Show this help message

${COLORS.bright}Country Codes (SerpAPI - ISO 3166-1 alpha-2):${COLORS.reset}
  us = USA, gb = UK, au = Australia, ca = Canada, de = Germany
  Full list: https://serpapi.com/google-countries

${COLORS.bright}Examples:${COLORS.reset}
  npm run dev -- generate https://example.com
  npm run dev -- generate https://example.com -p 3 -f 10
  npm run dev -- generate https://example.com -c gb   # UK-based searches
  npm run dev -- generate https://example.com --skip-fact-check
`);
}

async function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(`${COLORS.cyan}? ${COLORS.reset}${question} `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function interactiveMode(): Promise<void> {
  printBanner();
  console.log(`${COLORS.dim}Interactive Mode - Follow the prompts to generate FAQ content${COLORS.reset}\n`);

  // Get URL
  let url = '';
  while (!isValidUrl(url)) {
    url = await promptUser('Enter the website URL to analyze:');
    if (!isValidUrl(url)) {
      console.log(`${COLORS.red}Invalid URL. Please enter a valid URL (e.g., https://example.com)${COLORS.reset}`);
    }
  }

  // Get number of personas
  const personasInput = await promptUser('Number of personas to generate (default: 5):');
  const numberOfPersonas = parseInt(personasInput) || 5;

  // Get FAQs per category
  const faqsInput = await promptUser('Maximum FAQs per category (default: 5):');
  const maxFAQsPerCategory = parseInt(faqsInput) || 5;

  // Ask about Google Docs
  const googleDocsInput = await promptUser('Save to Google Docs? (y/n, default: y):');
  const saveToGoogleDocs = googleDocsInput.toLowerCase() !== 'n';

  // Ask about fact-checking
  const factCheckInput = await promptUser('Run fact-checking? (y/n, default: y):');
  const skipFactCheck = factCheckInput.toLowerCase() === 'n';

  // Ask for search country (for SerpAPI)
  console.log(`\n${COLORS.dim}Country targeting for web searches (SerpAPI format - ISO 3166-1 alpha-2):${COLORS.reset}`);
  console.log(`${COLORS.dim}  Common codes: us (USA), gb (UK), au (Australia), ca (Canada), de (Germany)${COLORS.reset}`);
  console.log(`${COLORS.dim}  Full list: https://serpapi.com/google-countries${COLORS.reset}`);
  const countryInput = await promptUser('Enter country code (default: us):');
  const searchCountry = countryInput.toLowerCase().trim() || 'us';

  // Ask for sample outputs
  const sampleInput = await promptUser('Enter sample output text (optional, press Enter to skip):');
  const sampleOutputs = sampleInput ? [sampleInput] : undefined;

  console.log(`\n${COLORS.bright}Configuration:${COLORS.reset}`);
  console.log(`  URL: ${url}`);
  console.log(`  Personas: ${numberOfPersonas}`);
  console.log(`  FAQs per category: ${maxFAQsPerCategory}`);
  console.log(`  Search country: ${searchCountry.toUpperCase()}`);
  console.log(`  Google Docs: ${saveToGoogleDocs ? 'Yes' : 'No'}`);
  console.log(`  Fact-checking: ${!skipFactCheck ? 'Yes' : 'No'}`);
  console.log();

  const confirm = await promptUser('Proceed with generation? (y/n):');
  if (confirm.toLowerCase() !== 'y') {
    console.log('Operation cancelled.');
    return;
  }

  await runGeneration({
    url,
    sampleOutputs,
    options: {
      numberOfPersonas,
      maxFAQsPerCategory,
      saveToGoogleDocs,
      skipFactCheck,
      searchCountry,
    },
  });
}

async function runGeneration(input: OrchestratorInput): Promise<void> {
  console.log(`\n${COLORS.bright}Starting FAQ Generation...${COLORS.reset}\n`);

  const orchestrator = createFAQOrchestrator();

  try {
    const result = await orchestrator.executeWithProgress(
      input,
      (stage, progress, message) => {
        const progressBar = createProgressBar(progress);
        process.stdout.write(`\r${COLORS.dim}[${progressBar}]${COLORS.reset} ${stage}: ${message}    `);
        if (progress === 100) console.log();
      }
    );

    // Print summary
    console.log(`\n${COLORS.green}════════════════════════════════════════════════════════════════${COLORS.reset}`);
    console.log(`${COLORS.bright}${COLORS.green}✓ FAQ Generation Complete!${COLORS.reset}`);
    console.log(`${COLORS.green}════════════════════════════════════════════════════════════════${COLORS.reset}\n`);

    console.log(`${COLORS.bright}Summary:${COLORS.reset}`);
    console.log(`  Website: ${result.urlResearch.websiteAnalysis.title}`);
    console.log(`  Personas created: ${result.personas.length}`);
    console.log(`  FAQs generated: ${result.faqContent.totalFAQs}`);
    console.log(`  Categories: ${result.faqContent.categories.length}`);

    if (result.factCheckReport) {
      console.log(`\n${COLORS.bright}Fact-Check Results:${COLORS.reset}`);
      console.log(`  Verified: ${result.factCheckReport.verifiedCount}`);
      console.log(`  Partially Verified: ${result.factCheckReport.partiallyVerifiedCount}`);
      console.log(`  Unverified: ${result.factCheckReport.unverifiedCount}`);
      console.log(`  False: ${result.factCheckReport.falseCount}`);
      console.log(`  Outdated: ${result.factCheckReport.outdatedCount}`);
    }

    if (result.googleDocs && result.googleDocs.length > 0) {
      console.log(`\n${COLORS.bright}Google Docs Created:${COLORS.reset}`);
      result.googleDocs.forEach(doc => {
        console.log(`  - ${doc.title}`);
        console.log(`    ${COLORS.cyan}${doc.url}${COLORS.reset}`);
      });
    }

    console.log(`\n${COLORS.dim}Execution time: ${formatDuration(result.executionTime)}${COLORS.reset}`);
    console.log(`${COLORS.dim}Output saved to: ./output/${COLORS.reset}\n`);

  } catch (error) {
    console.log();
    logger.error('Generation failed', error);
    process.exit(1);
  }
}

function createProgressBar(percentage: number): string {
  const width = 30;
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return `${COLORS.green}${'█'.repeat(filled)}${COLORS.dim}${'░'.repeat(empty)}${COLORS.reset}`;
}

export async function main(): Promise<void> {
  // Validate configuration
  try {
    const config = loadConfig();
    const validation = validateConfig(config);
    if (!validation.valid) {
      console.error(`${COLORS.red}Configuration errors:${COLORS.reset}`);
      validation.errors.forEach(err => console.error(`  - ${err}`));
      console.error(`\n${COLORS.yellow}Please create a .env file with required configuration.${COLORS.reset}`);
      console.error(`${COLORS.dim}See .env.example for reference.${COLORS.reset}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`${COLORS.red}Failed to load configuration:${COLORS.reset}`, error);
    console.error(`\n${COLORS.yellow}Please ensure ANTHROPIC_API_KEY is set in your .env file.${COLORS.reset}`);
    process.exit(1);
  }

  const program = new Command();

  program
    .name('faq-generator')
    .description('Multi-Agent FAQ Content Generator')
    .version('1.0.0');

  program
    .command('generate <url>')
    .description('Generate FAQ content for a website URL')
    .option('-p, --personas <number>', 'Number of personas to generate', '5')
    .option('-f, --faqs <number>', 'Max FAQs per category', '5')
    .option('-o, --output <dir>', 'Output directory', './output')
    .option('-c, --country <code>', 'Country for SerpAPI searches (ISO 3166-1: us, gb, au, ca)', 'us')
    .option('--no-google-docs', 'Skip Google Docs creation')
    .option('--skip-fact-check', 'Skip fact-checking step')
    .action(async (url: string, options: Record<string, string | boolean>) => {
      printBanner();

      if (!isValidUrl(url)) {
        console.error(`${COLORS.red}Invalid URL: ${url}${COLORS.reset}`);
        process.exit(1);
      }

      const orchestratorOptions: OrchestratorOptions = {
        numberOfPersonas: parseInt(options.personas as string) || 5,
        maxFAQsPerCategory: parseInt(options.faqs as string) || 5,
        outputDir: (options.output as string) || './output',
        saveToGoogleDocs: options.googleDocs !== false,
        skipFactCheck: options.skipFactCheck === true,
        searchCountry: ((options.country as string) || 'us').toLowerCase(),
      };

      await runGeneration({ url, options: orchestratorOptions });
    });

  program
    .command('interactive')
    .description('Start interactive mode')
    .action(async () => {
      await interactiveMode();
    });

  program
    .command('help')
    .description('Show help')
    .action(() => {
      printBanner();
      printHelp();
    });

  // Default to interactive if no command specified
  if (process.argv.length <= 2) {
    await interactiveMode();
  } else {
    program.parse(process.argv);
  }
}

// Export for testing
export { runGeneration, interactiveMode };
