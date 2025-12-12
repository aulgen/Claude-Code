/**
 * Web Search Service
 *
 * Performs web searches to gather external data for deep research:
 * - Real "People Also Ask" questions from search engines
 * - Industry trends and context
 * - Competitor information
 * - Market research data
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { createLogger } from '../utils/logger';
import { sleep, retryWithBackoff } from '../utils/helpers';

const logger = createLogger('WebSearchService');

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface PAAResult {
  question: string;
  source: string;
}

export interface WebResearchData {
  paaQuestions: PAAResult[];
  industryInsights: SearchResult[];
  competitorInfo: SearchResult[];
  relatedTopics: string[];
}

export class WebSearchService {
  private userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

  /**
   * Perform comprehensive web research for a topic/industry
   */
  async performDeepResearch(
    topic: string,
    industry: string,
    keywords: string[]
  ): Promise<WebResearchData> {
    logger.info(`Performing deep web research for: ${topic} in ${industry}`);

    const results: WebResearchData = {
      paaQuestions: [],
      industryInsights: [],
      competitorInfo: [],
      relatedTopics: [],
    };

    try {
      // Search for PAA questions
      logger.info('Searching for People Also Ask questions...');
      const paaQuestions = await this.searchForPAAQuestions(topic, industry, keywords);
      results.paaQuestions = paaQuestions;
      logger.success(`Found ${paaQuestions.length} PAA questions from web search`);

      // Small delay between searches
      await sleep(500);

      // Search for industry insights
      logger.info('Searching for industry insights...');
      const industryInsights = await this.searchForIndustryInsights(industry, keywords);
      results.industryInsights = industryInsights;
      logger.success(`Found ${industryInsights.length} industry insights`);

      await sleep(500);

      // Search for competitor/market info
      logger.info('Searching for market information...');
      const competitorInfo = await this.searchForMarketInfo(topic, industry);
      results.competitorInfo = competitorInfo;
      logger.success(`Found ${competitorInfo.length} market insights`);

      // Extract related topics from all results
      results.relatedTopics = this.extractRelatedTopics(results);

    } catch (error) {
      logger.warn('Some web searches failed, continuing with available data');
      logger.debug(`Web search error: ${error instanceof Error ? error.message : String(error)}`);
    }

    return results;
  }

  /**
   * Search for "People Also Ask" style questions
   */
  private async searchForPAAQuestions(
    topic: string,
    industry: string,
    keywords: string[]
  ): Promise<PAAResult[]> {
    const allQuestions: PAAResult[] = [];

    // Build search queries for PAA-style questions
    const searchQueries = [
      `${topic} questions`,
      `${topic} FAQ`,
      `what is ${topic}`,
      `how does ${topic} work`,
      `${industry} common questions`,
      `${topic} guide`,
      ...keywords.slice(0, 3).map(k => `${k} questions`),
    ];

    for (const query of searchQueries.slice(0, 5)) { // Limit to 5 queries
      try {
        await sleep(300); // Rate limiting
        const results = await this.performSearch(query);

        // Extract questions from search results
        const questions = this.extractQuestionsFromResults(results, query);
        allQuestions.push(...questions);
      } catch (error) {
        logger.debug(`Search failed for query: ${query}`);
      }
    }

    // Deduplicate questions
    const uniqueQuestions = this.deduplicateQuestions(allQuestions);
    return uniqueQuestions.slice(0, 25); // Return top 25 questions
  }

  /**
   * Search for industry insights and trends
   */
  private async searchForIndustryInsights(
    industry: string,
    keywords: string[]
  ): Promise<SearchResult[]> {
    const queries = [
      `${industry} trends 2024`,
      `${industry} best practices`,
      `${industry} statistics`,
      ...keywords.slice(0, 2).map(k => `${k} industry insights`),
    ];

    const allResults: SearchResult[] = [];

    for (const query of queries.slice(0, 3)) {
      try {
        await sleep(300);
        const results = await this.performSearch(query);
        allResults.push(...results.slice(0, 5));
      } catch (error) {
        logger.debug(`Industry search failed for: ${query}`);
      }
    }

    return this.deduplicateResults(allResults).slice(0, 15);
  }

  /**
   * Search for market/competitor information
   */
  private async searchForMarketInfo(
    topic: string,
    industry: string
  ): Promise<SearchResult[]> {
    const queries = [
      `${topic} comparison`,
      `best ${topic} providers`,
      `${industry} market overview`,
      `${topic} vs alternatives`,
    ];

    const allResults: SearchResult[] = [];

    for (const query of queries.slice(0, 3)) {
      try {
        await sleep(300);
        const results = await this.performSearch(query);
        allResults.push(...results.slice(0, 5));
      } catch (error) {
        logger.debug(`Market search failed for: ${query}`);
      }
    }

    return this.deduplicateResults(allResults).slice(0, 10);
  }

  /**
   * Perform a web search using DuckDuckGo HTML
   */
  private async performSearch(query: string): Promise<SearchResult[]> {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    try {
      const response = await retryWithBackoff(
        async () => {
          return axios.get(url, {
            headers: {
              'User-Agent': this.userAgent,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.5',
              'Accept-Encoding': 'gzip, deflate',
              'Connection': 'keep-alive',
            },
            timeout: 15000,
          });
        },
        2,
        1000
      );

      return this.parseDuckDuckGoResults(response.data);
    } catch (error) {
      logger.debug(`Search request failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Parse DuckDuckGo HTML search results
   */
  private parseDuckDuckGoResults(html: string): SearchResult[] {
    const results: SearchResult[] = [];
    const $ = cheerio.load(html);

    // DuckDuckGo HTML results structure
    $('.result').each((_, element) => {
      const titleEl = $(element).find('.result__title a');
      const snippetEl = $(element).find('.result__snippet');

      const title = titleEl.text().trim();
      const url = titleEl.attr('href') || '';
      const snippet = snippetEl.text().trim();

      if (title && snippet) {
        // Clean up DuckDuckGo redirect URLs
        let cleanUrl = url;
        if (url.includes('uddg=')) {
          const match = url.match(/uddg=([^&]+)/);
          if (match) {
            cleanUrl = decodeURIComponent(match[1]);
          }
        }

        results.push({
          title,
          url: cleanUrl,
          snippet,
        });
      }
    });

    return results;
  }

  /**
   * Extract questions from search results
   */
  private extractQuestionsFromResults(results: SearchResult[], sourceQuery: string): PAAResult[] {
    const questions: PAAResult[] = [];

    // Common question patterns
    const questionPatterns = [
      /what\s+(?:is|are|does|do|should|can|will|would)\s+[^?.!]+\??/gi,
      /how\s+(?:to|do|does|can|should|much|many|long|often)\s+[^?.!]+\??/gi,
      /why\s+(?:is|are|do|does|should|would)\s+[^?.!]+\??/gi,
      /when\s+(?:should|do|does|is|are|to)\s+[^?.!]+\??/gi,
      /where\s+(?:can|do|does|is|are|to)\s+[^?.!]+\??/gi,
      /which\s+[^?.!]+\??/gi,
      /is\s+[^?.!]+\??/gi,
      /can\s+[^?.!]+\??/gi,
      /does\s+[^?.!]+\??/gi,
      /do\s+(?:i|you|we|they)\s+[^?.!]+\??/gi,
    ];

    for (const result of results) {
      const textToSearch = `${result.title} ${result.snippet}`;

      for (const pattern of questionPatterns) {
        const matches = textToSearch.match(pattern);
        if (matches) {
          for (const match of matches) {
            let question = match.trim();
            // Ensure it ends with a question mark
            if (!question.endsWith('?')) {
              question += '?';
            }
            // Capitalize first letter
            question = question.charAt(0).toUpperCase() + question.slice(1);

            // Only add if it's a reasonable question length
            if (question.length > 15 && question.length < 150) {
              questions.push({
                question,
                source: sourceQuery,
              });
            }
          }
        }
      }

      // Also check if the title itself is a question
      if (result.title.includes('?') ||
          result.title.toLowerCase().startsWith('what') ||
          result.title.toLowerCase().startsWith('how') ||
          result.title.toLowerCase().startsWith('why') ||
          result.title.toLowerCase().startsWith('when') ||
          result.title.toLowerCase().startsWith('where')) {
        let question = result.title.trim();
        if (!question.endsWith('?')) {
          question += '?';
        }
        questions.push({
          question,
          source: sourceQuery,
        });
      }
    }

    return questions;
  }

  /**
   * Deduplicate questions based on similarity
   */
  private deduplicateQuestions(questions: PAAResult[]): PAAResult[] {
    const seen = new Set<string>();
    const unique: PAAResult[] = [];

    for (const q of questions) {
      // Normalize for comparison
      const normalized = q.question.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

      // Skip if too similar to existing
      let isDuplicate = false;
      for (const existing of seen) {
        if (this.isSimilar(normalized, existing)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && normalized.length > 10) {
        seen.add(normalized);
        unique.push(q);
      }
    }

    return unique;
  }

  /**
   * Check if two strings are similar (simple Jaccard similarity)
   */
  private isSimilar(a: string, b: string): boolean {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));

    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);

    const similarity = intersection.size / union.size;
    return similarity > 0.7; // 70% similar words = duplicate
  }

  /**
   * Deduplicate search results
   */
  private deduplicateResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    return results.filter(r => {
      const key = r.url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Extract related topics from all research data
   */
  private extractRelatedTopics(data: WebResearchData): string[] {
    const topics = new Set<string>();

    // Extract from PAA questions
    for (const paa of data.paaQuestions) {
      // Extract key phrases from questions
      const words = paa.question.toLowerCase()
        .replace(/[?.,!]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 4);
      words.forEach(w => topics.add(w));
    }

    // Extract from search result titles
    for (const result of [...data.industryInsights, ...data.competitorInfo]) {
      const words = result.title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 4);
      words.slice(0, 3).forEach(w => topics.add(w));
    }

    return Array.from(topics).slice(0, 30);
  }
}

export function createWebSearchService(): WebSearchService {
  return new WebSearchService();
}
