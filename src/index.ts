/**
 * FAQ Content Generator
 *
 * A multi-agent system for generating comprehensive FAQ content based on:
 * 1. Website URL analysis
 * 2. Persona generation
 * 3. People Also Ask questions
 * 4. Fact-checking and verification
 *
 * Outputs are saved as Google Docs and local files.
 */

import { main } from './cli';

// Run the CLI
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Export modules for programmatic usage
export * from './types';
export * from './agents';
export * from './tools';
export * from './orchestrator';
export * from './utils';
