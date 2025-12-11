/**
 * URL Research Agent
 *
 * This agent analyzes a website URL to:
 * 1. Scrape and extract content from the website
 * 2. Analyze the website's purpose, target audience, and key offerings
 * 3. Generate "People Also Ask" style questions based on the content
 * 4. Identify competitive insights and industry context
 */

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import {
  AgentConfig,
  AgentResponse,
  URLResearchResult,
  WebsiteAnalysis,
  PeopleAlsoAskQuestion,
} from '../types';
import { createLogger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { cleanText, truncate, extractDomain, retryWithBackoff, extractJson, safeJsonParse } from '../utils/helpers';

const logger = createLogger('URLResearchAgent');

interface ScrapedContent {
  title: string;
  description: string;
  headings: string[];
  paragraphs: string[];
  links: { text: string; href: string }[];
  metaKeywords: string[];
  rawText: string;
}

export class URLResearchAgent {
  private config: AgentConfig;
  private anthropic: Anthropic;

  constructor() {
    const appConfig = getConfig();
    this.config = {
      name: 'URL Research Agent',
      description: 'Analyzes websites to extract insights and generate research data',
      model: appConfig.anthropic.model,
      maxTokens: 4096,
      temperature: 0.3,
    };
    this.anthropic = new Anthropic({
      apiKey: appConfig.anthropic.apiKey,
    });
  }

  /**
   * Main execution method
   */
  async execute(url: string): Promise<AgentResponse<URLResearchResult>> {
    logger.section('URL Research Agent');
    logger.info(`Analyzing URL: ${url}`);

    try {
      // Step 1: Scrape the website
      logger.info('Scraping website content...');
      const scrapedContent = await this.scrapeWebsite(url);
      logger.success(`Scraped ${scrapedContent.paragraphs.length} paragraphs and ${scrapedContent.headings.length} headings`);

      // Step 2: Analyze the website
      logger.info('Analyzing website content with AI...');
      const websiteAnalysis = await this.analyzeWebsite(url, scrapedContent);
      logger.success('Website analysis complete');

      // Step 3: Generate People Also Ask questions
      logger.info('Generating People Also Ask questions...');
      const peopleAlsoAsk = await this.generatePeopleAlsoAsk(websiteAnalysis, scrapedContent);
      logger.success(`Generated ${peopleAlsoAsk.length} PAA questions`);

      const result: URLResearchResult = {
        websiteAnalysis,
        peopleAlsoAsk,
        rawContent: truncate(scrapedContent.rawText, 10000),
        scrapedAt: new Date(),
      };

      return {
        success: true,
        data: result,
        metadata: {
          url,
          domain: extractDomain(url),
          contentLength: scrapedContent.rawText.length,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('URL Research failed', error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Scrape content from a website
   */
  private async scrapeWebsite(url: string): Promise<ScrapedContent> {
    const response = await retryWithBackoff(
      async () => {
        return axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
          timeout: 30000,
          maxRedirects: 5,
        });
      },
      3,
      2000
    );

    const $ = cheerio.load(response.data);

    // Remove script, style, and other non-content elements
    $('script, style, noscript, iframe, nav, footer, header, aside').remove();

    // Extract metadata
    const title = $('title').text().trim() || $('h1').first().text().trim() || '';
    const description = $('meta[name="description"]').attr('content') ||
                       $('meta[property="og:description"]').attr('content') || '';
    const metaKeywords = ($('meta[name="keywords"]').attr('content') || '').split(',').map(k => k.trim()).filter(Boolean);

    // Extract headings
    const headings: string[] = [];
    $('h1, h2, h3, h4').each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 2) {
        headings.push(cleanText(text));
      }
    });

    // Extract paragraphs
    const paragraphs: string[] = [];
    $('p, li, article, section > div').each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 20) {
        paragraphs.push(cleanText(text));
      }
    });

    // Extract links
    const links: { text: string; href: string }[] = [];
    $('a[href]').each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (text && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        links.push({ text: cleanText(text), href });
      }
    });

    // Get raw text
    const rawText = cleanText($('body').text());

    return {
      title,
      description,
      headings: [...new Set(headings)].slice(0, 50),
      paragraphs: [...new Set(paragraphs)].slice(0, 100),
      links: links.slice(0, 50),
      metaKeywords,
      rawText: truncate(rawText, 50000),
    };
  }

  /**
   * Analyze website content using Claude
   */
  private async analyzeWebsite(url: string, content: ScrapedContent): Promise<WebsiteAnalysis> {
    const prompt = `Analyze this website and provide a comprehensive analysis in JSON format.

URL: ${url}
Title: ${content.title}
Description: ${content.description}

Headings:
${content.headings.slice(0, 30).join('\n')}

Content Excerpts:
${content.paragraphs.slice(0, 30).join('\n\n')}

Meta Keywords: ${content.metaKeywords.join(', ')}

Provide a JSON response with the following structure:
{
  "url": "${url}",
  "title": "The website's title or name",
  "description": "A comprehensive description of what the website is about (2-3 sentences)",
  "mainTopics": ["Array of 5-8 main topics covered by the website"],
  "targetAudience": ["Array of 3-5 target audience segments"],
  "industryContext": "The industry or sector this website operates in",
  "keyProducts": ["Array of key products if applicable, or empty array"],
  "keyServices": ["Array of key services if applicable, or empty array"],
  "uniqueSellingPoints": ["Array of 3-5 unique value propositions"],
  "brandVoice": "Description of the brand's tone and voice (professional, casual, technical, etc.)",
  "contentThemes": ["Array of 5-7 recurring content themes"]
}

Return ONLY the JSON object, no additional text.`;

    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;

    const analysis = safeJsonParse<WebsiteAnalysis>(jsonStr, {
      url,
      title: content.title,
      description: content.description,
      mainTopics: [],
      targetAudience: [],
      industryContext: 'Unknown',
      keyProducts: [],
      keyServices: [],
      uniqueSellingPoints: [],
      brandVoice: 'Professional',
      contentThemes: [],
    });

    // Ensure URL is set
    analysis.url = url;

    return analysis;
  }

  /**
   * Generate People Also Ask questions
   */
  private async generatePeopleAlsoAsk(
    analysis: WebsiteAnalysis,
    content: ScrapedContent
  ): Promise<PeopleAlsoAskQuestion[]> {
    const prompt = `Based on this website analysis, generate "People Also Ask" style questions that users would search for.

Website: ${analysis.title}
Industry: ${analysis.industryContext}
Main Topics: ${analysis.mainTopics.join(', ')}
Target Audience: ${analysis.targetAudience.join(', ')}
Products/Services: ${[...analysis.keyProducts || [], ...analysis.keyServices || []].join(', ')}

Content Context:
${content.headings.slice(0, 20).join('\n')}

Generate 15-20 diverse questions that cover:
1. Informational queries (what, how, why questions about the topic)
2. Navigational queries (finding specific things)
3. Transactional queries (buying, signing up, pricing)
4. Commercial investigation (comparisons, reviews, alternatives)

Return a JSON array with this structure:
[
  {
    "question": "The question text",
    "relatedTopics": ["topic1", "topic2"],
    "searchIntent": "informational|navigational|transactional|commercial",
    "estimatedRelevance": 0.0-1.0
  }
]

Return ONLY the JSON array, no additional text.`;

    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;

    const questions = safeJsonParse<PeopleAlsoAskQuestion[]>(jsonStr, []);

    // Validate and clean the questions
    return questions
      .filter(q => q.question && q.question.length > 10)
      .map(q => ({
        question: q.question,
        relatedTopics: q.relatedTopics || [],
        searchIntent: q.searchIntent || 'informational',
        estimatedRelevance: typeof q.estimatedRelevance === 'number' ? q.estimatedRelevance : 0.5,
      }));
  }

  /**
   * Helper method to call Claude API
   */
  private async callClaude(prompt: string): Promise<string> {
    const response = await retryWithBackoff(
      async () => {
        return this.anthropic.messages.create({
          model: this.config.model,
          max_tokens: this.config.maxTokens || 4096,
          temperature: this.config.temperature || 0.3,
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
}

export function createURLResearchAgent(): URLResearchAgent {
  return new URLResearchAgent();
}
