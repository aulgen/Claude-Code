/**
 * FAQ Content Generator Orchestrator
 *
 * This orchestrator coordinates all agents to generate comprehensive FAQ content:
 * 1. URL Research Agent - Analyzes the website and extracts PAA questions
 * 2. Persona Generator Agent - Creates 5 user personas
 * 3. FAQ Content Generator Agent - Generates categorized FAQs with internal links
 * 4. Fact Checker Agent - Verifies content and provides recommendations
 * 5. Google Docs Service - Saves all outputs as Google Docs
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  OrchestratorInput,
  OrchestratorOptions,
  OrchestratorResult,
  Persona,
  FAQContentResult,
  FactCheckReport,
  GoogleDocMetadata,
  FAQItem,
} from '../types';
import {
  createURLResearchAgent,
  createPersonaGeneratorAgent,
  createFAQGeneratorAgent,
  createFactCheckerAgent,
} from '../agents';
import { createGoogleDocsService } from '../tools';
import { createLogger } from '../utils/logger';
import { getConfig, ensureOutputDirectory } from '../utils/config';
import { formatDuration, sanitizeFilename } from '../utils/helpers';

const logger = createLogger('Orchestrator');

export class FAQOrchestrator {
  private urlResearchAgent = createURLResearchAgent();
  private personaGeneratorAgent = createPersonaGeneratorAgent();
  private faqGeneratorAgent = createFAQGeneratorAgent();
  private factCheckerAgent = createFactCheckerAgent();
  private googleDocsService = createGoogleDocsService();

  private defaultOptions: OrchestratorOptions = {
    numberOfPersonas: 5,
    maxFAQsPerCategory: 5,
    skipFactCheck: false,
    saveToGoogleDocs: true,
    outputDir: './output',
  };

  /**
   * Execute the full FAQ generation pipeline
   */
  async execute(input: OrchestratorInput): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const options = { ...this.defaultOptions, ...input.options };

    logger.section('FAQ Content Generator');
    logger.info(`Processing URL: ${input.url}`);

    // Initialize Google Docs if needed
    let googleDocsEnabled = false;
    if (options.saveToGoogleDocs) {
      googleDocsEnabled = await this.googleDocsService.initialize();
    }

    // Ensure output directory exists
    const config = getConfig();
    ensureOutputDirectory(config);

    const googleDocs: GoogleDocMetadata[] = [];

    try {
      // ========================================
      // STEP 1: URL Research
      // ========================================
      logger.section('Step 1: URL Research');
      const urlResearchResult = await this.urlResearchAgent.execute(input.url);

      if (!urlResearchResult.success || !urlResearchResult.data) {
        throw new Error(`URL Research failed: ${urlResearchResult.error}`);
      }

      const urlResearch = urlResearchResult.data;
      logger.success(`Analyzed ${urlResearch.websiteAnalysis.title}`);
      logger.info(`Found ${urlResearch.peopleAlsoAsk.length} PAA questions`);

      // ========================================
      // STEP 2: Persona Generation
      // ========================================
      logger.section('Step 2: Persona Generation');
      const personaResult = await this.personaGeneratorAgent.execute({
        websiteAnalysis: urlResearch.websiteAnalysis,
        peopleAlsoAsk: urlResearch.peopleAlsoAsk,
        sampleOutputs: input.sampleOutputs,
        numberOfPersonas: options.numberOfPersonas,
        subspecialties: urlResearch.subspecialties, // Pass subspecialties from web search
      });

      if (!personaResult.success || !personaResult.data) {
        throw new Error(`Persona generation failed: ${personaResult.error}`);
      }

      const personas = personaResult.data.personas;
      logger.success(`Generated ${personas.length} personas`);
      if (urlResearch.subspecialties && urlResearch.subspecialties.length > 0) {
        logger.info(`Based on ${urlResearch.subspecialties.length} discovered subspecialties`);
      }

      // Save personas to Google Docs
      if (googleDocsEnabled) {
        logger.info('Saving personas to Google Docs...');
        const personaDocs = await this.googleDocsService.createAllPersonaDocuments(
          personas,
          urlResearch.websiteAnalysis.title
        );
        googleDocs.push(...personaDocs);
        logger.success(`Created ${personaDocs.length} persona documents`);
      }

      // Save personas locally
      await this.savePersonasLocally(personas, urlResearch.websiteAnalysis.title, options.outputDir!);

      // ========================================
      // STEP 3: FAQ Content Generation
      // ========================================
      logger.section('Step 3: FAQ Content Generation');
      const faqResult = await this.faqGeneratorAgent.execute({
        websiteAnalysis: urlResearch.websiteAnalysis,
        personas,
        peopleAlsoAsk: urlResearch.peopleAlsoAsk,
        maxFAQsPerCategory: options.maxFAQsPerCategory,
      });

      if (!faqResult.success || !faqResult.data) {
        throw new Error(`FAQ generation failed: ${faqResult.error}`);
      }

      const faqContent = faqResult.data;
      logger.success(`Generated ${faqContent.totalFAQs} FAQs in ${faqContent.categories.length} categories`);

      // Save FAQ content to Google Docs
      if (googleDocsEnabled) {
        logger.info('Saving FAQ content to Google Docs...');
        const faqDoc = await this.googleDocsService.createFAQDocument(
          faqContent,
          urlResearch.websiteAnalysis.title
        );
        if (faqDoc) {
          googleDocs.push(faqDoc);
          logger.success('Created FAQ document');
        }
      }

      // Save FAQ content locally
      await this.saveFAQsLocally(faqContent, urlResearch.websiteAnalysis.title, options.outputDir!);

      // ========================================
      // STEP 4: Fact Checking (Optional)
      // ========================================
      let factCheckReport: FactCheckReport | undefined;

      if (!options.skipFactCheck) {
        logger.section('Step 4: Fact Checking');

        // Flatten all FAQs for fact-checking
        const allFAQs: FAQItem[] = faqContent.categories.flatMap(cat => cat.faqs);

        const factCheckResult = await this.factCheckerAgent.execute({
          faqs: allFAQs,
          websiteUrl: input.url,
        });

        if (factCheckResult.success && factCheckResult.data) {
          factCheckReport = factCheckResult.data;
          logger.success(`Fact-checked ${factCheckReport.totalFAQsChecked} FAQs`);
          logger.info(`Results: ${factCheckReport.verifiedCount} verified, ${factCheckReport.unverifiedCount} unverified, ${factCheckReport.falseCount} false`);

          // Save fact-check report to Google Docs
          if (googleDocsEnabled) {
            logger.info('Saving fact-check report to Google Docs...');
            const factCheckDoc = await this.googleDocsService.createFactCheckDocument(
              factCheckReport,
              urlResearch.websiteAnalysis.title
            );
            if (factCheckDoc) {
              googleDocs.push(factCheckDoc);
              logger.success('Created fact-check report document');
            }
          }

          // Save fact-check report locally
          await this.saveFactCheckReportLocally(factCheckReport, urlResearch.websiteAnalysis.title, options.outputDir!);
        } else {
          logger.warn('Fact-checking failed, continuing without verification');
        }
      }

      // ========================================
      // COMPLETE
      // ========================================
      const executionTime = Date.now() - startTime;

      logger.section('Generation Complete');
      logger.success(`Total execution time: ${formatDuration(executionTime)}`);

      if (googleDocs.length > 0) {
        logger.info('Google Docs created:');
        googleDocs.forEach(doc => {
          console.log(`  - ${doc.title}: ${doc.url}`);
        });
      }

      return {
        urlResearch,
        personas,
        faqContent,
        factCheckReport,
        googleDocs: googleDocs.length > 0 ? googleDocs : undefined,
        executionTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('Orchestration failed', error);
      throw new Error(`FAQ generation failed: ${errorMessage}`);
    }
  }

  /**
   * Save personas to local files
   */
  private async savePersonasLocally(
    personas: Persona[],
    websiteTitle: string,
    outputDir: string
  ): Promise<void> {
    const sanitizedTitle = sanitizeFilename(websiteTitle);
    const personasDir = path.join(outputDir, sanitizedTitle, 'personas');

    if (!fs.existsSync(personasDir)) {
      fs.mkdirSync(personasDir, { recursive: true });
    }

    for (const persona of personas) {
      const filename = `${sanitizeFilename(persona.name)}.md`;
      const filepath = path.join(personasDir, filename);
      const content = this.personaGeneratorAgent.formatPersonaForExport(persona);
      fs.writeFileSync(filepath, content);
    }

    logger.info(`Saved ${personas.length} persona files to ${personasDir}`);
  }

  /**
   * Save FAQ content to local file
   */
  private async saveFAQsLocally(
    faqContent: FAQContentResult,
    websiteTitle: string,
    outputDir: string
  ): Promise<void> {
    const sanitizedTitle = sanitizeFilename(websiteTitle);
    const faqDir = path.join(outputDir, sanitizedTitle);

    if (!fs.existsSync(faqDir)) {
      fs.mkdirSync(faqDir, { recursive: true });
    }

    const filepath = path.join(faqDir, 'faq-content.md');
    const content = this.faqGeneratorAgent.formatFAQsForExport(faqContent);
    fs.writeFileSync(filepath, content);

    // Also save as JSON for programmatic access
    const jsonPath = path.join(faqDir, 'faq-content.json');
    fs.writeFileSync(jsonPath, JSON.stringify(faqContent, null, 2));

    logger.info(`Saved FAQ content to ${faqDir}`);
  }

  /**
   * Save fact-check report to local file
   */
  private async saveFactCheckReportLocally(
    report: FactCheckReport,
    websiteTitle: string,
    outputDir: string
  ): Promise<void> {
    const sanitizedTitle = sanitizeFilename(websiteTitle);
    const reportDir = path.join(outputDir, sanitizedTitle);

    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const filepath = path.join(reportDir, 'fact-check-report.md');
    const content = this.factCheckerAgent.formatReportForExport(report);
    fs.writeFileSync(filepath, content);

    // Also save as JSON
    const jsonPath = path.join(reportDir, 'fact-check-report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    logger.info(`Saved fact-check report to ${reportDir}`);
  }

  /**
   * Run with progress callback
   */
  async executeWithProgress(
    input: OrchestratorInput,
    onProgress: (stage: string, progress: number, message: string) => void
  ): Promise<OrchestratorResult> {
    onProgress('Initializing', 0, 'Starting FAQ generation...');

    const startTime = Date.now();
    const options = { ...this.defaultOptions, ...input.options };

    // Initialize Google Docs if needed
    let googleDocsEnabled = false;
    if (options.saveToGoogleDocs) {
      onProgress('Initializing', 5, 'Connecting to Google Docs...');
      googleDocsEnabled = await this.googleDocsService.initialize();
    }

    const config = getConfig();
    ensureOutputDirectory(config);

    const googleDocs: GoogleDocMetadata[] = [];

    // Step 1: URL Research (0-25%)
    onProgress('URL Research', 10, 'Analyzing website...');
    const urlResearchResult = await this.urlResearchAgent.execute(input.url);
    if (!urlResearchResult.success || !urlResearchResult.data) {
      throw new Error(`URL Research failed: ${urlResearchResult.error}`);
    }
    const urlResearch = urlResearchResult.data;
    onProgress('URL Research', 25, `Found ${urlResearch.peopleAlsoAsk.length} questions`);

    // Step 2: Persona Generation (25-45%)
    onProgress('Persona Generation', 30, 'Creating personas...');
    const personaResult = await this.personaGeneratorAgent.execute({
      websiteAnalysis: urlResearch.websiteAnalysis,
      peopleAlsoAsk: urlResearch.peopleAlsoAsk,
      sampleOutputs: input.sampleOutputs,
      numberOfPersonas: options.numberOfPersonas,
      subspecialties: urlResearch.subspecialties, // Pass subspecialties from web search
    });
    if (!personaResult.success || !personaResult.data) {
      throw new Error(`Persona generation failed: ${personaResult.error}`);
    }
    const personas = personaResult.data.personas;
    const subspecialtyMsg = urlResearch.subspecialties?.length
      ? ` (${urlResearch.subspecialties.length} subspecialties)`
      : '';
    onProgress('Persona Generation', 45, `Created ${personas.length} personas${subspecialtyMsg}`);

    // Save personas
    if (googleDocsEnabled) {
      onProgress('Saving', 48, 'Saving personas to Google Docs...');
      const personaDocs = await this.googleDocsService.createAllPersonaDocuments(
        personas,
        urlResearch.websiteAnalysis.title
      );
      googleDocs.push(...personaDocs);
    }
    await this.savePersonasLocally(personas, urlResearch.websiteAnalysis.title, options.outputDir!);

    // Step 3: FAQ Generation (45-70%)
    onProgress('FAQ Generation', 50, 'Generating FAQ content...');
    const faqResult = await this.faqGeneratorAgent.execute({
      websiteAnalysis: urlResearch.websiteAnalysis,
      personas,
      peopleAlsoAsk: urlResearch.peopleAlsoAsk,
      maxFAQsPerCategory: options.maxFAQsPerCategory,
    });
    if (!faqResult.success || !faqResult.data) {
      throw new Error(`FAQ generation failed: ${faqResult.error}`);
    }
    const faqContent = faqResult.data;
    onProgress('FAQ Generation', 70, `Generated ${faqContent.totalFAQs} FAQs`);

    // Save FAQs
    if (googleDocsEnabled) {
      onProgress('Saving', 73, 'Saving FAQs to Google Docs...');
      const faqDoc = await this.googleDocsService.createFAQDocument(
        faqContent,
        urlResearch.websiteAnalysis.title
      );
      if (faqDoc) googleDocs.push(faqDoc);
    }
    await this.saveFAQsLocally(faqContent, urlResearch.websiteAnalysis.title, options.outputDir!);

    // Step 4: Fact Checking (70-95%)
    let factCheckReport: FactCheckReport | undefined;
    if (!options.skipFactCheck) {
      onProgress('Fact Checking', 75, 'Verifying content...');
      const allFAQs: FAQItem[] = faqContent.categories.flatMap(cat => cat.faqs);
      const factCheckResult = await this.factCheckerAgent.execute({
        faqs: allFAQs,
        websiteUrl: input.url,
      });

      if (factCheckResult.success && factCheckResult.data) {
        factCheckReport = factCheckResult.data;
        onProgress('Fact Checking', 90, `Verified ${factCheckReport.totalFAQsChecked} FAQs`);

        if (googleDocsEnabled) {
          onProgress('Saving', 93, 'Saving fact-check report...');
          const factCheckDoc = await this.googleDocsService.createFactCheckDocument(
            factCheckReport,
            urlResearch.websiteAnalysis.title
          );
          if (factCheckDoc) googleDocs.push(factCheckDoc);
        }
        await this.saveFactCheckReportLocally(factCheckReport, urlResearch.websiteAnalysis.title, options.outputDir!);
      }
    }

    // Complete
    const executionTime = Date.now() - startTime;
    onProgress('Complete', 100, `Done in ${formatDuration(executionTime)}`);

    return {
      urlResearch,
      personas,
      faqContent,
      factCheckReport,
      googleDocs: googleDocs.length > 0 ? googleDocs : undefined,
      executionTime,
    };
  }
}

export function createFAQOrchestrator(): FAQOrchestrator {
  return new FAQOrchestrator();
}
