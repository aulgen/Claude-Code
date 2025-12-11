/**
 * FAQ Content Generator Agent
 *
 * This agent generates comprehensive FAQ content based on:
 * 1. Website analysis
 * 2. User personas
 * 3. People Also Ask questions
 * 4. Internal links from the source website (for contextual linking)
 *
 * Output: Categorized FAQ items with questions and answers tailored to personas,
 * enriched with relevant internal links from the source website
 */

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import {
  AgentConfig,
  AgentResponse,
  FAQItem,
  FAQCategory,
  FAQContentResult,
  FAQGeneratorInput,
  Persona,
  WebsiteAnalysis,
  PeopleAlsoAskQuestion,
} from '../types';
import { createLogger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { generateSimpleId, retryWithBackoff, extractJson, safeJsonParse, cleanText, extractDomain } from '../utils/helpers';

const logger = createLogger('FAQGeneratorAgent');

interface RawFAQCategory {
  name: string;
  description: string;
  faqs: {
    question: string;
    answer: string;
    targetPersonas: string[];
    keywords: string[];
    priority: string;
    contentType: string;
  }[];
}

interface InternalLink {
  url: string;
  text: string;
  context: string; // Surrounding text for context
  pageTitle?: string;
  topics: string[];
}

interface FAQWithLinks extends FAQItem {
  internalLinks: { url: string; anchorText: string; relevance: string }[];
}

export class FAQGeneratorAgent {
  private config: AgentConfig;
  private anthropic: Anthropic;
  private internalLinks: InternalLink[] = [];
  private sourceUrl: string = '';

  constructor() {
    const appConfig = getConfig();
    this.config = {
      name: 'FAQ Content Generator Agent',
      description: 'Generates comprehensive FAQ content based on personas and research',
      model: appConfig.anthropic.model,
      maxTokens: 8192,
      temperature: 0.5,
    };
    this.anthropic = new Anthropic({
      apiKey: appConfig.anthropic.apiKey,
    });
  }

  /**
   * Main execution method
   */
  async execute(input: FAQGeneratorInput): Promise<AgentResponse<FAQContentResult>> {
    logger.section('FAQ Content Generator Agent');
    logger.info('Generating FAQ content...');

    try {
      // Step 0: Scan source URL for internal links (if URL is provided)
      if (input.websiteAnalysis.url) {
        this.sourceUrl = input.websiteAnalysis.url;
        logger.info('Scanning source URL for internal links...');
        await this.scanForInternalLinks(input.websiteAnalysis.url);
        logger.success(`Found ${this.internalLinks.length} internal links`);
      }

      // Step 1: Determine FAQ categories
      logger.info('Determining FAQ categories...');
      const categoryNames = await this.determineFAQCategories(input.websiteAnalysis, input.personas);
      logger.success(`Identified ${categoryNames.length} categories`);

      // Step 2: Generate FAQ content for each category
      const categories: FAQCategory[] = [];
      for (let i = 0; i < categoryNames.length; i++) {
        const categoryName = categoryNames[i];
        logger.progress('Generating FAQs', i + 1, categoryNames.length, categoryName);

        const category = await this.generateFAQsForCategory(
          categoryName,
          input.websiteAnalysis,
          input.personas,
          input.peopleAlsoAsk,
          input.maxFAQsPerCategory || 5
        );

        // Enrich FAQs with internal links
        const enrichedFAQs = await this.enrichFAQsWithInternalLinks(category.faqs);
        category.faqs = enrichedFAQs;

        categories.push(category);
      }

      // Calculate coverage statistics
      const coverageByPersona = this.calculatePersonaCoverage(categories, input.personas);

      const result: FAQContentResult = {
        categories,
        totalFAQs: categories.reduce((sum, cat) => sum + cat.faqs.length, 0),
        coverageByPersona,
        generatedAt: new Date(),
      };

      logger.success(`Generated ${result.totalFAQs} FAQs across ${categories.length} categories with internal links`);

      return {
        success: true,
        data: result,
        metadata: {
          categoryCount: categories.length,
          totalFAQs: result.totalFAQs,
          internalLinksFound: this.internalLinks.length,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('FAQ generation failed', error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Scan a URL and extract all internal links with context
   */
  private async scanForInternalLinks(url: string): Promise<void> {
    try {
      const response = await retryWithBackoff(
        async () => {
          return axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            },
            timeout: 30000,
            maxRedirects: 5,
          });
        },
        3,
        2000
      );

      const $ = cheerio.load(response.data);
      const sourceDomain = extractDomain(url);
      const pageTitle = $('title').text().trim();

      // Remove script, style, and navigation elements for cleaner context
      $('script, style, noscript').remove();

      // Find all internal links
      $('a[href]').each((_, element) => {
        const href = $(element).attr('href') || '';
        const text = $(element).text().trim();

        // Skip empty links, anchors, javascript, and external links
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
          return;
        }

        // Resolve relative URLs
        let fullUrl: string;
        try {
          fullUrl = new URL(href, url).href;
        } catch {
          return;
        }

        // Check if it's an internal link
        const linkDomain = extractDomain(fullUrl);
        if (linkDomain !== sourceDomain) {
          return;
        }

        // Skip if link text is too short or generic
        if (text.length < 3 || ['click here', 'read more', 'learn more', 'here'].includes(text.toLowerCase())) {
          // Use surrounding text or alt text instead
          const parent = $(element).parent();
          const surroundingText = cleanText(parent.text()).substring(0, 200);
          if (surroundingText.length < 10) return;
        }

        // Get context from surrounding elements
        const parent = $(element).parent();
        let context = '';

        // Try to get context from parent paragraph or list item
        const parentP = $(element).closest('p, li, div, article');
        if (parentP.length > 0) {
          context = cleanText(parentP.text()).substring(0, 300);
        } else {
          context = cleanText(parent.text()).substring(0, 300);
        }

        // Extract topics/keywords from URL path
        const urlPath = new URL(fullUrl).pathname;
        const topics = urlPath
          .split('/')
          .filter(segment => segment && segment.length > 2)
          .map(segment => segment.replace(/-/g, ' ').replace(/_/g, ' '));

        this.internalLinks.push({
          url: fullUrl,
          text: text || topics.join(' '),
          context,
          pageTitle,
          topics,
        });
      });

      // Deduplicate links by URL
      const uniqueLinks = new Map<string, InternalLink>();
      this.internalLinks.forEach(link => {
        if (!uniqueLinks.has(link.url) || link.text.length > (uniqueLinks.get(link.url)?.text.length || 0)) {
          uniqueLinks.set(link.url, link);
        }
      });
      this.internalLinks = Array.from(uniqueLinks.values());

      logger.debug(`Extracted ${this.internalLinks.length} unique internal links`);
    } catch (error) {
      logger.warn('Could not scan URL for internal links:', error);
      this.internalLinks = [];
    }
  }

  /**
   * Enrich FAQ answers with relevant internal links
   */
  private async enrichFAQsWithInternalLinks(faqs: FAQItem[]): Promise<FAQItem[]> {
    if (this.internalLinks.length === 0) {
      return faqs;
    }

    const enrichedFAQs: FAQItem[] = [];

    for (const faq of faqs) {
      const enrichedAnswer = await this.addInternalLinksToAnswer(faq);
      enrichedFAQs.push({
        ...faq,
        answer: enrichedAnswer,
      });
    }

    return enrichedFAQs;
  }

  /**
   * Add relevant internal links to a single FAQ answer
   */
  private async addInternalLinksToAnswer(faq: FAQItem): Promise<string> {
    // Prepare link context for the AI
    const linkSummaries = this.internalLinks
      .slice(0, 30) // Limit to top 30 links
      .map((link, index) =>
        `[${index}] URL: ${link.url}\n    Text: "${link.text}"\n    Topics: ${link.topics.join(', ')}`
      )
      .join('\n');

    const prompt = `You are enhancing an FAQ answer by adding relevant internal links from the website.

## FAQ Question
${faq.question}

## Current Answer
${faq.answer}

## Available Internal Links
${linkSummaries}

## Task
Rewrite the answer to naturally incorporate 1-3 relevant internal links where appropriate.

Guidelines:
1. Only add links where they genuinely add value and context
2. Use markdown link format: [anchor text](URL)
3. The anchor text should flow naturally in the sentence
4. Don't force links - if none are relevant, return the original answer
5. Prefer links that provide additional information the reader might want
6. Don't add more than 3 links to avoid overwhelming the reader
7. Keep the original meaning and structure of the answer

Return ONLY the enhanced answer text with embedded markdown links. Do not include any explanation or JSON formatting.`;

    try {
      const response = await this.callClaude(prompt);
      // Clean up any potential JSON wrapper or extra formatting
      let cleanedResponse = response.trim();

      // If response looks like JSON, try to extract the text
      if (cleanedResponse.startsWith('{') || cleanedResponse.startsWith('"')) {
        const extracted = extractJson(cleanedResponse);
        if (extracted) {
          try {
            const parsed = JSON.parse(extracted);
            if (typeof parsed === 'string') {
              cleanedResponse = parsed;
            } else if (parsed.answer) {
              cleanedResponse = parsed.answer;
            }
          } catch {
            // If parsing fails, use the original response
          }
        }
      }

      return cleanedResponse;
    } catch (error) {
      logger.warn(`Could not add internal links to FAQ: ${faq.question}`);
      return faq.answer;
    }
  }

  /**
   * Determine appropriate FAQ categories based on website and personas
   */
  private async determineFAQCategories(
    analysis: WebsiteAnalysis,
    personas: Persona[]
  ): Promise<string[]> {
    const personaNeeds = personas.flatMap(p => [
      ...p.painPoints.challenges,
      ...p.goals.primaryGoals,
    ]);

    const prompt = `Based on this website analysis and user needs, determine 5-7 FAQ categories.

Website: ${analysis.title}
Industry: ${analysis.industryContext}
Main Topics: ${analysis.mainTopics.join(', ')}
Products/Services: ${[...analysis.keyProducts || [], ...analysis.keyServices || []].join(', ')}

User Needs:
${personaNeeds.slice(0, 15).map(n => `- ${n}`).join('\n')}

Provide 5-7 FAQ categories that would be most valuable. Categories should:
1. Cover the most common user questions
2. Address different stages of the user journey
3. Include both product/service-specific and general topics

Return ONLY a JSON array of category names, e.g.:
["Getting Started", "Pricing & Plans", "Technical Support", "Features & Capabilities", "Account Management"]`;

    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;
    const categories = safeJsonParse<string[]>(jsonStr, []);

    // Default categories if parsing fails
    if (categories.length === 0) {
      return [
        'Getting Started',
        'Product Features',
        'Pricing & Billing',
        'Technical Support',
        'Account & Security',
      ];
    }

    return categories;
  }

  /**
   * Generate FAQs for a specific category
   */
  private async generateFAQsForCategory(
    categoryName: string,
    analysis: WebsiteAnalysis,
    personas: Persona[],
    paaQuestions: PeopleAlsoAskQuestion[],
    maxFAQs: number
  ): Promise<FAQCategory> {
    const personaContext = personas.map(p =>
      `${p.name} (${p.title}): Questions - ${p.typicalQuestions.slice(0, 3).join('; ')}`
    ).join('\n');

    const relevantPAA = paaQuestions
      .slice(0, 10)
      .map(q => `- ${q.question}`)
      .join('\n');

    // Include available internal links for context
    const linkTopics = [...new Set(this.internalLinks.flatMap(l => l.topics))].slice(0, 20);
    const linkContext = linkTopics.length > 0
      ? `\n## Available Topics (can reference in answers)\n${linkTopics.join(', ')}`
      : '';

    const prompt = `Generate ${maxFAQs} high-quality FAQs for the "${categoryName}" category.

## Website Context
- **Website:** ${analysis.title}
- **Industry:** ${analysis.industryContext}
- **Description:** ${analysis.description}
- **Brand Voice:** ${analysis.brandVoice}
- **Key Topics:** ${analysis.mainTopics.join(', ')}
${linkContext}

## User Personas
${personaContext}

## Related Questions Users Ask
${relevantPAA}

## Instructions
Generate ${maxFAQs} FAQs that:
1. Are directly relevant to the "${categoryName}" category
2. Address real user concerns and questions
3. Provide comprehensive, helpful answers (150-300 words each)
4. Match the brand voice: ${analysis.brandVoice}
5. Include actionable information where appropriate
6. Reference related topics where relevant (these will be linked later)

Return a JSON object with this structure:
{
  "name": "${categoryName}",
  "description": "A brief description of what this category covers",
  "faqs": [
    {
      "question": "The FAQ question",
      "answer": "A comprehensive answer (150-300 words) that is helpful and accurate",
      "targetPersonas": ["Names of personas this FAQ is most relevant to"],
      "keywords": ["3-5 relevant keywords"],
      "priority": "high|medium|low",
      "contentType": "factual|procedural|conceptual|troubleshooting"
    }
  ]
}

Return ONLY the JSON object, no additional text.`;

    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;
    const rawCategory = safeJsonParse<RawFAQCategory>(jsonStr, {
      name: categoryName,
      description: `FAQs about ${categoryName}`,
      faqs: [],
    });

    // Transform to proper types with IDs
    const faqs: FAQItem[] = rawCategory.faqs.map(faq => ({
      id: generateSimpleId(),
      question: faq.question,
      answer: faq.answer,
      category: categoryName,
      targetPersonas: faq.targetPersonas || [],
      keywords: faq.keywords || [],
      priority: this.validatePriority(faq.priority),
      contentType: this.validateContentType(faq.contentType),
    }));

    return {
      id: generateSimpleId(),
      name: rawCategory.name || categoryName,
      description: rawCategory.description || `FAQs about ${categoryName}`,
      faqs,
    };
  }

  /**
   * Validate priority value
   */
  private validatePriority(priority: string): 'high' | 'medium' | 'low' {
    const valid = ['high', 'medium', 'low'];
    return valid.includes(priority) ? priority as 'high' | 'medium' | 'low' : 'medium';
  }

  /**
   * Validate content type value
   */
  private validateContentType(contentType: string): 'factual' | 'procedural' | 'conceptual' | 'troubleshooting' {
    const valid = ['factual', 'procedural', 'conceptual', 'troubleshooting'];
    return valid.includes(contentType) ? contentType as 'factual' | 'procedural' | 'conceptual' | 'troubleshooting' : 'factual';
  }

  /**
   * Calculate persona coverage across all FAQs
   */
  private calculatePersonaCoverage(
    categories: FAQCategory[],
    personas: Persona[]
  ): Record<string, number> {
    const coverage: Record<string, number> = {};

    personas.forEach(p => {
      coverage[p.name] = 0;
    });

    categories.forEach(cat => {
      cat.faqs.forEach(faq => {
        faq.targetPersonas.forEach(personaName => {
          if (coverage[personaName] !== undefined) {
            coverage[personaName]++;
          }
        });
      });
    });

    return coverage;
  }

  /**
   * Get the list of extracted internal links
   */
  getInternalLinks(): InternalLink[] {
    return this.internalLinks;
  }

  /**
   * Helper method to call Claude API
   */
  private async callClaude(prompt: string): Promise<string> {
    const response = await retryWithBackoff(
      async () => {
        return this.anthropic.messages.create({
          model: this.config.model,
          max_tokens: this.config.maxTokens || 8192,
          temperature: this.config.temperature || 0.5,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        });
      },
      3,
      2000
    );

    const content = response.content[0];
    if (content.type === 'text') {
      return content.text;
    }
    throw new Error('Unexpected response type from Claude');
  }

  /**
   * Format FAQs for export (with internal link information)
   */
  formatFAQsForExport(result: FAQContentResult): string {
    let output = `# FAQ Content\n\n`;
    output += `*Generated on ${result.generatedAt.toISOString()}*\n\n`;
    output += `**Total FAQs:** ${result.totalFAQs}\n`;
    output += `**Categories:** ${result.categories.length}\n`;
    output += `**Internal Links Available:** ${this.internalLinks.length}\n\n`;
    output += `---\n\n`;

    result.categories.forEach(category => {
      output += `## ${category.name}\n\n`;
      output += `*${category.description}*\n\n`;

      category.faqs.forEach((faq, index) => {
        output += `### ${index + 1}. ${faq.question}\n\n`;
        output += `${faq.answer}\n\n`;
        output += `**Keywords:** ${faq.keywords.join(', ')}\n`;
        output += `**Priority:** ${faq.priority} | **Type:** ${faq.contentType}\n\n`;
        output += `---\n\n`;
      });
    });

    // Add internal links reference section
    if (this.internalLinks.length > 0) {
      output += `\n## Internal Links Reference\n\n`;
      output += `The following internal links were available for contextual linking:\n\n`;
      this.internalLinks.slice(0, 20).forEach(link => {
        output += `- [${link.text}](${link.url})\n`;
      });
    }

    return output;
  }
}

export function createFAQGeneratorAgent(): FAQGeneratorAgent {
  return new FAQGeneratorAgent();
}
