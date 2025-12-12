/**
 * URL Research Agent
 *
 * This agent performs deep research on a website URL:
 * 1. Scrapes the main page and discovers internal links
 * 2. Scrapes additional related pages for comprehensive understanding
 * 3. PERFORMS WEB SEARCH for external data, subspecialties, and risk profiles
 * 4. Analyzes the website's purpose, target audience, and key offerings
 * 5. Generates "People Also Ask" questions from REAL web search data
 * 6. Identifies competitive insights and industry context
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
import { cleanText, truncate, extractDomain, retryWithBackoff, extractJson, safeJsonParse, sleep } from '../utils/helpers';
import { createWebSearchService, WebSearchService, WebResearchData } from '../services/webSearchService';

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

interface ScrapedPage {
  url: string;
  content: ScrapedContent;
}

export class URLResearchAgent {
  private config: AgentConfig;
  private anthropic: Anthropic;
  private webSearch: WebSearchService;
  private maxPagesToScrape: number = 5; // Scrape up to 5 pages for deeper research

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
    this.webSearch = createWebSearchService();
  }

  /**
   * Main execution method - performs deep research
   */
  async execute(url: string): Promise<AgentResponse<URLResearchResult>> {
    logger.section('URL Research Agent');
    logger.info(`Analyzing URL: ${url}`);

    try {
      // Step 1: Scrape the main page
      logger.info('Scraping main page content...');
      const mainContent = await this.scrapeWebsite(url);
      logger.success(`Scraped main page: ${mainContent.paragraphs.length} paragraphs, ${mainContent.headings.length} headings`);

      // Step 2: Discover and scrape related internal pages for deeper research
      logger.info('Performing deep research - discovering related pages...');
      const allScrapedPages = await this.scrapeRelatedPages(url, mainContent);
      logger.success(`Deep research complete: analyzed ${allScrapedPages.length} pages total`);

      // Step 3: Combine all scraped content
      const combinedContent = this.combineScrapedContent(mainContent, allScrapedPages);
      logger.info(`Combined content: ${combinedContent.paragraphs.length} paragraphs, ${combinedContent.headings.length} headings`);

      // Step 4: Analyze the website with comprehensive data
      logger.info('Analyzing website content with AI...');
      const websiteAnalysis = await this.analyzeWebsite(url, combinedContent);
      logger.success('Website analysis complete');

      // Step 5: PERFORM WEB SEARCH for external research (subspecialties, PAA, industry data)
      logger.info('Performing web search for external research data...');
      const webResearchData = await this.performWebResearch(websiteAnalysis, combinedContent);
      logger.success(`Web search complete: ${webResearchData.subspecialties.length} subspecialties, ${webResearchData.paaQuestions.length} PAA questions`);

      // Step 6: Generate People Also Ask questions using web search data + AI
      logger.info('Generating People Also Ask questions from web research...');
      const peopleAlsoAsk = await this.generatePeopleAlsoAskWithWebData(
        websiteAnalysis,
        combinedContent,
        webResearchData
      );
      logger.success(`Generated ${peopleAlsoAsk.length} PAA questions (web + AI)`);

      // Validate we have enough data
      if (peopleAlsoAsk.length === 0) {
        logger.warn('No PAA questions generated, attempting fallback generation...');
        const fallbackPAA = await this.generateFallbackPAA(websiteAnalysis);
        peopleAlsoAsk.push(...fallbackPAA);
        logger.success(`Fallback generated ${fallbackPAA.length} PAA questions`);
      }

      const result: URLResearchResult = {
        websiteAnalysis,
        peopleAlsoAsk,
        subspecialties: webResearchData.subspecialties,
        industryInsights: webResearchData.industryInsights.map(r => r.snippet),
        rawContent: truncate(combinedContent.rawText, 15000),
        scrapedAt: new Date(),
      };

      return {
        success: true,
        data: result,
        metadata: {
          url,
          domain: extractDomain(url),
          contentLength: combinedContent.rawText.length,
          pagesScraped: allScrapedPages.length + 1,
        },
      };
    } catch (error) {
      // Extract error message properly for different error types
      let errorMessage = 'Unknown error occurred';

      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (typeof error === 'object' && error !== null) {
        // Handle Anthropic API errors and other object errors
        const errorObj = error as Record<string, unknown>;
        if ('message' in errorObj && typeof errorObj.message === 'string') {
          errorMessage = errorObj.message;
        } else if ('error' in errorObj && typeof errorObj.error === 'object') {
          const nestedError = errorObj.error as Record<string, unknown>;
          if ('message' in nestedError && typeof nestedError.message === 'string') {
            errorMessage = nestedError.message;
          }
        }
        // Log the full error object for debugging
        try {
          logger.error('URL Research failed with details:', JSON.stringify(error, null, 2));
        } catch {
          logger.error('URL Research failed with non-serializable error');
        }
      } else if (typeof error === 'string') {
        errorMessage = error;
      }

      logger.error(`URL Research error: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Scrape related pages from the website for deeper research
   */
  private async scrapeRelatedPages(mainUrl: string, mainContent: ScrapedContent): Promise<ScrapedPage[]> {
    const scrapedPages: ScrapedPage[] = [];
    const mainDomain = extractDomain(mainUrl);
    const visitedUrls = new Set<string>([mainUrl]);

    // Find relevant internal links to scrape
    const relevantLinks = mainContent.links
      .filter(link => {
        try {
          const fullUrl = new URL(link.href, mainUrl).href;
          const linkDomain = extractDomain(fullUrl);
          // Only internal links, not already visited, not anchors/javascript
          return linkDomain === mainDomain &&
                 !visitedUrls.has(fullUrl) &&
                 !link.href.startsWith('#') &&
                 !link.href.startsWith('javascript:') &&
                 !link.href.includes('mailto:') &&
                 !link.href.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js)$/i);
        } catch {
          return false;
        }
      })
      .slice(0, this.maxPagesToScrape - 1); // Reserve one for main page

    logger.info(`Found ${relevantLinks.length} related pages to analyze`);

    for (const link of relevantLinks) {
      try {
        const fullUrl = new URL(link.href, mainUrl).href;
        if (visitedUrls.has(fullUrl)) continue;
        visitedUrls.add(fullUrl);

        logger.debug(`Scraping related page: ${link.text || fullUrl}`);
        await sleep(500); // Rate limiting

        const content = await this.scrapeWebsite(fullUrl);
        scrapedPages.push({ url: fullUrl, content });
        logger.debug(`  - Got ${content.paragraphs.length} paragraphs`);
      } catch (error) {
        logger.debug(`  - Failed to scrape: ${link.href}`);
        // Continue with other pages
      }
    }

    return scrapedPages;
  }

  /**
   * Combine content from multiple scraped pages
   */
  private combineScrapedContent(mainContent: ScrapedContent, additionalPages: ScrapedPage[]): ScrapedContent {
    const allHeadings = new Set(mainContent.headings);
    const allParagraphs = new Set(mainContent.paragraphs);
    const allLinks = [...mainContent.links];
    let allRawText = mainContent.rawText;

    for (const page of additionalPages) {
      page.content.headings.forEach(h => allHeadings.add(h));
      page.content.paragraphs.forEach(p => allParagraphs.add(p));
      allLinks.push(...page.content.links);
      allRawText += '\n\n' + page.content.rawText;
    }

    return {
      title: mainContent.title,
      description: mainContent.description,
      headings: Array.from(allHeadings).slice(0, 100),
      paragraphs: Array.from(allParagraphs).slice(0, 200),
      links: allLinks.slice(0, 100),
      metaKeywords: mainContent.metaKeywords,
      rawText: truncate(allRawText, 80000),
    };
  }

  /**
   * Scrape content from a single website page
   */
  private async scrapeWebsite(url: string): Promise<ScrapedContent> {
    const response = await retryWithBackoff(
      async () => {
        return axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            'Connection': 'keep-alive',
          },
          timeout: 30000,
          maxRedirects: 5,
          decompress: true,
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
    const prompt = `You are a market research expert. Analyze this website content and provide a comprehensive analysis.

URL: ${url}
Title: ${content.title}
Description: ${content.description}

All Headings Found:
${content.headings.slice(0, 50).join('\n')}

Content Excerpts (from multiple pages):
${content.paragraphs.slice(0, 50).join('\n\n')}

Meta Keywords: ${content.metaKeywords.join(', ')}

Based on this comprehensive research, provide a detailed JSON analysis:
{
  "url": "${url}",
  "title": "The website's title or brand name",
  "description": "A comprehensive description of what the website offers and its value proposition (3-4 sentences)",
  "mainTopics": ["List 8-10 main topics, services, or areas this website covers"],
  "targetAudience": ["List 5-7 specific target audience segments who would use this website"],
  "industryContext": "Detailed description of the industry/sector (e.g., 'Medical malpractice insurance for healthcare professionals')",
  "keyProducts": ["List specific products offered, if any"],
  "keyServices": ["List specific services offered"],
  "uniqueSellingPoints": ["List 5-7 unique value propositions or differentiators"],
  "brandVoice": "Describe the brand's communication style and tone in detail",
  "contentThemes": ["List 8-10 recurring themes or topics in the content"]
}

Be thorough and specific based on the scraped content. Return ONLY the JSON object.`;

    const response = await this.callClaude(prompt);
    logger.debug('Website analysis raw response length: ' + response.length);

    const jsonStr = extractJson(response) || response;
    const rawAnalysis = safeJsonParse<Partial<WebsiteAnalysis>>(jsonStr, {});

    // Ensure all required properties are set with defaults
    const analysis: WebsiteAnalysis = {
      url,
      title: rawAnalysis.title || content.title || 'Website',
      description: rawAnalysis.description || content.description || '',
      mainTopics: Array.isArray(rawAnalysis.mainTopics) ? rawAnalysis.mainTopics : [],
      targetAudience: Array.isArray(rawAnalysis.targetAudience) ? rawAnalysis.targetAudience : [],
      industryContext: rawAnalysis.industryContext || 'General',
      keyProducts: Array.isArray(rawAnalysis.keyProducts) ? rawAnalysis.keyProducts : [],
      keyServices: Array.isArray(rawAnalysis.keyServices) ? rawAnalysis.keyServices : [],
      uniqueSellingPoints: Array.isArray(rawAnalysis.uniqueSellingPoints) ? rawAnalysis.uniqueSellingPoints : [],
      brandVoice: rawAnalysis.brandVoice || 'Professional',
      contentThemes: Array.isArray(rawAnalysis.contentThemes) ? rawAnalysis.contentThemes : [],
    };

    // Log what we got for debugging
    logger.debug(`Analysis result: ${analysis.mainTopics.length} topics, ${analysis.targetAudience.length} audience segments`);

    // Log if we got minimal data
    if (analysis.mainTopics.length === 0) {
      logger.warn('Website analysis returned no main topics - content may be insufficient');
    }

    return analysis;
  }

  /**
   * Generate People Also Ask questions based on thorough research
   */
  private async generatePeopleAlsoAsk(
    analysis: WebsiteAnalysis,
    content: ScrapedContent
  ): Promise<PeopleAlsoAskQuestion[]> {
    // Build comprehensive context for PAA generation
    const topicsContext = analysis.mainTopics.length > 0
      ? analysis.mainTopics.join(', ')
      : content.headings.slice(0, 10).join(', ');

    const audienceContext = analysis.targetAudience.length > 0
      ? analysis.targetAudience.join(', ')
      : 'general website visitors';

    const servicesContext = [...(analysis.keyProducts || []), ...(analysis.keyServices || [])].join(', ') || 'various services';

    const prompt = `You are an SEO expert. Generate realistic "People Also Ask" questions that users would search for related to this website.

WEBSITE CONTEXT:
- Website: ${analysis.title}
- Industry: ${analysis.industryContext}
- Main Topics: ${topicsContext}
- Target Audience: ${audienceContext}
- Products/Services: ${servicesContext}
- Brand Voice: ${analysis.brandVoice}

CONTENT THEMES FROM RESEARCH:
${content.headings.slice(0, 30).map(h => `- ${h}`).join('\n')}

CONTENT EXCERPTS:
${content.paragraphs.slice(0, 15).join('\n')}

TASK:
Generate 20 realistic "People Also Ask" questions that potential customers would search for. These should be questions that would appear in Google's PAA boxes for searches related to this business.

Categories to cover:
1. INFORMATIONAL (5-6 questions): "What is...", "How does...", "Why do..."
2. COMPARISON (3-4 questions): "What's the difference between...", "X vs Y..."
3. COST/PRICING (3-4 questions): "How much does...", "What's the cost of..."
4. PROCESS (3-4 questions): "How to...", "Steps to...", "Process for..."
5. SPECIFIC TO INDUSTRY (4-5 questions): Questions specific to ${analysis.industryContext}

Return a JSON array with EXACTLY this structure (no deviations):
[
  {
    "question": "Full question text ending with ?",
    "relatedTopics": ["topic1", "topic2"],
    "searchIntent": "informational",
    "estimatedRelevance": 0.9
  }
]

Valid searchIntent values: "informational", "navigational", "transactional", "commercial"
estimatedRelevance should be between 0.5 and 1.0

Return ONLY the JSON array, nothing else.`;

    const response = await this.callClaude(prompt);
    logger.debug('PAA generation raw response length: ' + response.length);
    logger.debug('PAA response preview: ' + response.substring(0, 200));

    const jsonStr = extractJson(response) || response;
    const questions = safeJsonParse<PeopleAlsoAskQuestion[]>(jsonStr, []);

    logger.debug(`Parsed ${questions.length} PAA questions from response`);

    // Validate and clean the questions
    const validQuestions = questions
      .filter(q => q && q.question && typeof q.question === 'string' && q.question.length > 10)
      .map(q => ({
        question: q.question.trim(),
        relatedTopics: Array.isArray(q.relatedTopics) ? q.relatedTopics : [],
        searchIntent: ['informational', 'navigational', 'transactional', 'commercial'].includes(q.searchIntent)
          ? q.searchIntent
          : 'informational',
        estimatedRelevance: typeof q.estimatedRelevance === 'number' ? q.estimatedRelevance : 0.7,
      }));

    return validQuestions;
  }

  /**
   * Fallback PAA generation when primary method fails
   */
  private async generateFallbackPAA(analysis: WebsiteAnalysis): Promise<PeopleAlsoAskQuestion[]> {
    const prompt = `Generate 15 common "People Also Ask" questions for a business in the "${analysis.industryContext}" industry.

Business context:
- Name: ${analysis.title}
- Focus areas: ${analysis.mainTopics.slice(0, 5).join(', ') || 'general services'}
- Target customers: ${analysis.targetAudience.slice(0, 3).join(', ') || 'general audience'}

Generate questions covering:
- What the service/product is
- How it works
- Costs and pricing
- Benefits and advantages
- Common concerns
- Comparison with alternatives

Return as JSON array:
[{"question": "Question?", "relatedTopics": ["topic"], "searchIntent": "informational", "estimatedRelevance": 0.8}]

Only return the JSON array.`;

    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;
    const questions = safeJsonParse<PeopleAlsoAskQuestion[]>(jsonStr, []);

    return questions
      .filter(q => q && q.question && q.question.length > 10)
      .map(q => ({
        question: q.question,
        relatedTopics: q.relatedTopics || [],
        searchIntent: q.searchIntent || 'informational',
        estimatedRelevance: q.estimatedRelevance || 0.7,
      }));
  }

  /**
   * Perform web search to gather external research data including subspecialties
   */
  private async performWebResearch(
    analysis: WebsiteAnalysis,
    content: ScrapedContent
  ): Promise<WebResearchData> {
    // Build search keywords from website analysis
    const keywords: string[] = [
      ...analysis.mainTopics.slice(0, 5),
      ...analysis.targetAudience.slice(0, 3),
      ...(analysis.keyServices || []).slice(0, 3),
      ...(analysis.keyProducts || []).slice(0, 3),
    ].filter(Boolean);

    // Determine the main topic from title or content
    const mainTopic = analysis.title ||
                      content.headings[0] ||
                      analysis.mainTopics[0] ||
                      'general services';

    const industry = analysis.industryContext || 'general business';

    try {
      // Perform comprehensive web research including subspecialty discovery
      const webData = await this.webSearch.performDeepResearch(
        mainTopic,
        industry,
        keywords
      );

      logger.info(`Discovered ${webData.subspecialties.length} professional subspecialties`);
      if (webData.subspecialties.length > 0) {
        logger.debug(`Subspecialties: ${webData.subspecialties.map(s => s.name).join(', ')}`);
      }

      return webData;
    } catch (error) {
      logger.warn('Web search encountered errors, continuing with limited data');
      logger.debug(`Web search error: ${error instanceof Error ? error.message : String(error)}`);

      // Return empty data structure if web search fails
      return {
        paaQuestions: [],
        industryInsights: [],
        competitorInfo: [],
        relatedTopics: [],
        subspecialties: [],
        riskProfiles: [],
      };
    }
  }

  /**
   * Generate PAA questions using web search data + AI enhancement
   */
  private async generatePeopleAlsoAskWithWebData(
    analysis: WebsiteAnalysis,
    content: ScrapedContent,
    webData: WebResearchData
  ): Promise<PeopleAlsoAskQuestion[]> {
    const allQuestions: PeopleAlsoAskQuestion[] = [];

    // Convert web search PAA questions to our format
    for (const paa of webData.paaQuestions) {
      allQuestions.push({
        question: paa.question,
        relatedTopics: [paa.source],
        searchIntent: this.inferSearchIntent(paa.question),
        estimatedRelevance: 0.9, // High relevance - from real search
      });
    }

    logger.info(`Got ${allQuestions.length} questions from web search`);

    // If we have fewer than 15 questions from web search, supplement with AI
    if (allQuestions.length < 15) {
      logger.info('Supplementing with AI-generated questions...');
      const aiQuestions = await this.generatePeopleAlsoAsk(analysis, content);

      // Add AI questions that aren't duplicates
      const existingQuestions = new Set(
        allQuestions.map(q => q.question.toLowerCase().trim())
      );

      for (const aiQ of aiQuestions) {
        const normalized = aiQ.question.toLowerCase().trim();
        if (!existingQuestions.has(normalized)) {
          // Mark AI-generated questions with slightly lower relevance
          allQuestions.push({
            ...aiQ,
            estimatedRelevance: Math.min(aiQ.estimatedRelevance, 0.8),
          });
          existingQuestions.add(normalized);
        }
      }
    }

    // Sort by relevance and return top 25
    return allQuestions
      .sort((a, b) => b.estimatedRelevance - a.estimatedRelevance)
      .slice(0, 25);
  }

  /**
   * Infer search intent from question text
   */
  private inferSearchIntent(question: string): 'informational' | 'navigational' | 'transactional' | 'commercial' {
    const q = question.toLowerCase();

    if (q.includes('buy') || q.includes('purchase') || q.includes('order') || q.includes('get')) {
      return 'transactional';
    }
    if (q.includes('best') || q.includes('top') || q.includes('compare') || q.includes('vs') || q.includes('review')) {
      return 'commercial';
    }
    if (q.includes('how much') || q.includes('cost') || q.includes('price') || q.includes('pricing')) {
      return 'commercial';
    }
    if (q.includes('where') || q.includes('find') || q.includes('locate') || q.includes('near me')) {
      return 'navigational';
    }

    return 'informational';
  }

  /**
   * Helper method to call Claude API
   */
  private async callClaude(prompt: string): Promise<string> {
    try {
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
    } catch (error) {
      // Re-throw with better error message
      if (error instanceof Error) {
        throw error;
      }
      // Handle Anthropic API specific errors
      const errorObj = error as Record<string, unknown>;
      let message = 'API call failed';
      if ('message' in errorObj && typeof errorObj.message === 'string') {
        message = errorObj.message;
      } else if ('status' in errorObj) {
        message = `API returned status ${errorObj.status}`;
      }
      throw new Error(`Claude API error: ${message}`);
    }
  }
}

export function createURLResearchAgent(): URLResearchAgent {
  return new URLResearchAgent();
}
