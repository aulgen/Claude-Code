/**
 * Google Docs Service
 *
 * This service handles creating and managing Google Docs for:
 * 1. Persona documents
 * 2. FAQ content documents
 * 3. Fact-check reports
 *
 * Requires Google Cloud credentials with Google Docs API and Google Drive API enabled.
 */

import { google, docs_v1, drive_v3 } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import {
  GoogleDocMetadata,
  Persona,
  FAQContentResult,
  FactCheckReport,
} from '../types';
import { createLogger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { sanitizeFilename } from '../utils/helpers';

const logger = createLogger('GoogleDocsService');

interface GoogleAuthCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

export class GoogleDocsService {
  private docs: docs_v1.Docs | null = null;
  private drive: drive_v3.Drive | null = null;
  private isInitialized: boolean = false;
  private folderId?: string;

  constructor() {
    const config = getConfig();
    this.folderId = config.google.folderId;
  }

  /**
   * Initialize the Google API client
   */
  async initialize(): Promise<boolean> {
    const config = getConfig();

    try {
      const credentialsPath = path.resolve(config.google.credentialsPath);

      if (!fs.existsSync(credentialsPath)) {
        logger.warn('Google credentials file not found. Google Docs integration disabled.');
        return false;
      }

      const credentialsContent = fs.readFileSync(credentialsPath, 'utf-8');
      const credentials: GoogleAuthCredentials = JSON.parse(credentialsContent);

      const auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key,
        },
        scopes: [
          'https://www.googleapis.com/auth/documents',
          'https://www.googleapis.com/auth/drive.file',
        ],
      });

      const authClient = await auth.getClient();
      // @ts-expect-error - Google API types mismatch
      this.docs = google.docs({ version: 'v1', auth: authClient });
      // @ts-expect-error - Google API types mismatch
      this.drive = google.drive({ version: 'v3', auth: authClient });
      this.isInitialized = true;

      logger.success('Google Docs API initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Google Docs API', error);
      return false;
    }
  }

  /**
   * Check if the service is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Create a new Google Doc
   */
  async createDocument(title: string): Promise<GoogleDocMetadata | null> {
    if (!this.docs || !this.drive) {
      logger.warn('Google Docs API not initialized');
      return null;
    }

    try {
      // Create the document
      const response = await this.docs.documents.create({
        requestBody: {
          title,
        },
      });

      const documentId = response.data.documentId;
      if (!documentId) {
        throw new Error('No document ID returned');
      }

      // Move to specified folder if provided
      if (this.folderId) {
        await this.drive.files.update({
          fileId: documentId,
          addParents: this.folderId,
          fields: 'id, parents',
        });
      }

      const metadata: GoogleDocMetadata = {
        documentId,
        title,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
        createdAt: new Date(),
      };

      logger.success(`Created document: ${title}`);
      return metadata;
    } catch (error) {
      logger.error(`Failed to create document: ${title}`, error);
      return null;
    }
  }

  /**
   * Update document content with formatted text
   */
  async updateDocumentContent(
    documentId: string,
    content: string
  ): Promise<boolean> {
    if (!this.docs) {
      logger.warn('Google Docs API not initialized');
      return false;
    }

    try {
      // Parse markdown-like content and create requests
      const requests = this.parseContentToRequests(content);

      if (requests.length > 0) {
        await this.docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests,
          },
        });
      }

      return true;
    } catch (error) {
      logger.error('Failed to update document content', error);
      return false;
    }
  }

  /**
   * Parse markdown-like content to Google Docs API requests
   */
  private parseContentToRequests(content: string): docs_v1.Schema$Request[] {
    const requests: docs_v1.Schema$Request[] = [];
    let currentIndex = 1; // Google Docs index starts at 1

    const lines = content.split('\n');

    for (const line of lines) {
      if (!line.trim()) {
        // Empty line
        requests.push({
          insertText: {
            location: { index: currentIndex },
            text: '\n',
          },
        });
        currentIndex += 1;
        continue;
      }

      let text = line;
      let style: 'HEADING_1' | 'HEADING_2' | 'HEADING_3' | 'NORMAL_TEXT' = 'NORMAL_TEXT';

      // Parse headings
      if (line.startsWith('### ')) {
        text = line.substring(4);
        style = 'HEADING_3';
      } else if (line.startsWith('## ')) {
        text = line.substring(3);
        style = 'HEADING_2';
      } else if (line.startsWith('# ')) {
        text = line.substring(2);
        style = 'HEADING_1';
      }

      // Insert text
      requests.push({
        insertText: {
          location: { index: currentIndex },
          text: text + '\n',
        },
      });

      const textLength = text.length + 1;

      // Apply paragraph style
      if (style !== 'NORMAL_TEXT') {
        requests.push({
          updateParagraphStyle: {
            range: {
              startIndex: currentIndex,
              endIndex: currentIndex + textLength,
            },
            paragraphStyle: {
              namedStyleType: style,
            },
            fields: 'namedStyleType',
          },
        });
      }

      // Handle bold text (marked with **)
      const boldRegex = /\*\*(.+?)\*\*/g;
      let match;
      while ((match = boldRegex.exec(text)) !== null) {
        const boldStart = currentIndex + match.index;
        const boldEnd = boldStart + match[1].length;
        requests.push({
          updateTextStyle: {
            range: {
              startIndex: boldStart,
              endIndex: boldEnd,
            },
            textStyle: {
              bold: true,
            },
            fields: 'bold',
          },
        });
      }

      currentIndex += textLength;
    }

    return requests;
  }

  /**
   * Create a persona document
   */
  async createPersonaDocument(
    persona: Persona,
    websiteTitle: string
  ): Promise<GoogleDocMetadata | null> {
    const title = `Persona - ${persona.name} - ${sanitizeFilename(websiteTitle)}`;
    const metadata = await this.createDocument(title);

    if (!metadata) return null;

    const content = this.formatPersonaContent(persona, websiteTitle);
    await this.updateDocumentContent(metadata.documentId, content);

    return metadata;
  }

  /**
   * Format persona content for document
   */
  private formatPersonaContent(persona: Persona, websiteTitle: string): string {
    return `# ${persona.name}
## ${persona.title}

**Generated for:** ${websiteTitle}
**Generated on:** ${persona.createdAt.toISOString()}

---

## Bio

${persona.bio}

---

## Demographics

**Age Range:** ${persona.demographics.ageRange}
**Occupation:** ${persona.demographics.occupation}
**Location:** ${persona.demographics.location}
**Education Level:** ${persona.demographics.educationLevel}
${persona.demographics.incomeLevel ? `**Income Level:** ${persona.demographics.incomeLevel}` : ''}

---

## Journey Stage

**${persona.journeyStage.charAt(0).toUpperCase() + persona.journeyStage.slice(1)}**

---

## Online Behavior

**Online Habits:**
${persona.behavior.onlineHabits.map(h => `- ${h}`).join('\n')}

**Preferred Channels:**
${persona.behavior.preferredChannels.map(c => `- ${c}`).join('\n')}

**Decision Making Style:** ${persona.behavior.decisionMakingStyle}

**Information Sources:**
${persona.behavior.informationSources.map(s => `- ${s}`).join('\n')}

---

## Pain Points

### Challenges
${persona.painPoints.challenges.map(c => `- ${c}`).join('\n')}

### Frustrations
${persona.painPoints.frustrations.map(f => `- ${f}`).join('\n')}

### Unmet Needs
${persona.painPoints.unmetNeeds.map(n => `- ${n}`).join('\n')}

---

## Goals

### Primary Goals
${persona.goals.primaryGoals.map(g => `- ${g}`).join('\n')}

### Secondary Goals
${persona.goals.secondaryGoals.map(g => `- ${g}`).join('\n')}

### Motivations
${persona.goals.motivations.map(m => `- ${m}`).join('\n')}

---

## Typical Questions

${persona.typicalQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

---

## Preferred Content Formats

${persona.preferredContentFormat.map(f => `- ${f}`).join('\n')}
`;
  }

  /**
   * Create FAQ content document
   */
  async createFAQDocument(
    faqContent: FAQContentResult,
    websiteTitle: string
  ): Promise<GoogleDocMetadata | null> {
    const title = `FAQ Content - ${sanitizeFilename(websiteTitle)}`;
    const metadata = await this.createDocument(title);

    if (!metadata) return null;

    const content = this.formatFAQContent(faqContent, websiteTitle);
    await this.updateDocumentContent(metadata.documentId, content);

    return metadata;
  }

  /**
   * Format FAQ content for document
   */
  private formatFAQContent(faqContent: FAQContentResult, websiteTitle: string): string {
    let output = `# FAQ Content

**Generated for:** ${websiteTitle}
**Generated on:** ${faqContent.generatedAt.toISOString()}
**Total FAQs:** ${faqContent.totalFAQs}
**Categories:** ${faqContent.categories.length}

---

`;

    faqContent.categories.forEach(category => {
      output += `## ${category.name}

${category.description}

`;

      category.faqs.forEach((faq, index) => {
        output += `### ${index + 1}. ${faq.question}

${faq.answer}

**Keywords:** ${faq.keywords.join(', ')}
**Priority:** ${faq.priority}
**Type:** ${faq.contentType}

---

`;
      });
    });

    return output;
  }

  /**
   * Create fact-check report document
   */
  async createFactCheckDocument(
    report: FactCheckReport,
    websiteTitle: string
  ): Promise<GoogleDocMetadata | null> {
    const title = `Fact-Check Report - ${sanitizeFilename(websiteTitle)}`;
    const metadata = await this.createDocument(title);

    if (!metadata) return null;

    const content = this.formatFactCheckContent(report, websiteTitle);
    await this.updateDocumentContent(metadata.documentId, content);

    return metadata;
  }

  /**
   * Format fact-check report for document
   */
  private formatFactCheckContent(report: FactCheckReport, websiteTitle: string): string {
    let output = `# Fact-Check Report

**Generated for:** ${websiteTitle}
**Generated on:** ${report.generatedAt.toISOString()}

---

## Summary Statistics

| Metric | Count |
|--------|-------|
| Total FAQs Checked | ${report.totalFAQsChecked} |
| Verified | ${report.verifiedCount} |
| Partially Verified | ${report.partiallyVerifiedCount} |
| Unverified | ${report.unverifiedCount} |
| False | ${report.falseCount} |
| Outdated | ${report.outdatedCount} |

---

## Executive Summary

${report.summary}

---

## Detailed Results

`;

    report.results.forEach((result, index) => {
      const statusEmoji = {
        keep: 'KEEP',
        amend: 'AMEND',
        remove: 'REMOVE',
        needs_review: 'REVIEW',
      }[result.recommendation.action];

      output += `### ${index + 1}. ${result.question}

**Recommendation:** ${statusEmoji} (Priority: ${result.recommendation.priority})
**Verification Score:** ${Math.round(result.overallVerificationScore * 100)}%

**Claims Verified:**
${result.claims.map(c => `- ${c.claim}: ${c.status} (${Math.round(c.confidence * 100)}%)`).join('\n')}

**Reasoning:** ${result.recommendation.reasoning}

${result.recommendation.suggestedChanges ? `**Suggested Changes:** ${result.recommendation.suggestedChanges}` : ''}

---

`;
    });

    return output;
  }

  /**
   * Create all persona documents
   */
  async createAllPersonaDocuments(
    personas: Persona[],
    websiteTitle: string
  ): Promise<GoogleDocMetadata[]> {
    const documents: GoogleDocMetadata[] = [];

    for (const persona of personas) {
      logger.info(`Creating document for persona: ${persona.name}`);
      const doc = await this.createPersonaDocument(persona, websiteTitle);
      if (doc) {
        documents.push(doc);
      }
    }

    return documents;
  }
}

export function createGoogleDocsService(): GoogleDocsService {
  return new GoogleDocsService();
}
