/**
 * Web Search Service
 *
 * Performs web searches to gather external data for deep research:
 * - Real "People Also Ask" questions from search engines
 * - Industry trends and context
 * - INDUSTRY-SPECIFIC: Professional subspecialties and risk profiles
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

export interface SubspecialtyInfo {
  name: string;
  description: string;
  riskFactors: string[];
  commonConcerns: string[];
}

export interface WebResearchData {
  paaQuestions: PAAResult[];
  industryInsights: SearchResult[];
  competitorInfo: SearchResult[];
  relatedTopics: string[];
  subspecialties: SubspecialtyInfo[];
  riskProfiles: SearchResult[];
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
      subspecialties: [],
      riskProfiles: [],
    };

    try {
      // Step 1: Search for SUBSPECIALTIES within the profession/industry
      logger.info('Searching for professional subspecialties and types...');
      const subspecialtyData = await this.searchForSubspecialties(topic, industry);
      results.subspecialties = subspecialtyData.subspecialties;
      results.riskProfiles = subspecialtyData.riskResults;
      logger.success(`Found ${results.subspecialties.length} subspecialties/types`);

      await sleep(500);

      // Step 2: Search for PAA questions
      logger.info('Searching for People Also Ask questions...');
      const paaQuestions = await this.searchForPAAQuestions(topic, industry, keywords, results.subspecialties);
      results.paaQuestions = paaQuestions;
      logger.success(`Found ${paaQuestions.length} PAA questions from web search`);

      await sleep(500);

      // Step 3: Search for industry insights
      logger.info('Searching for industry insights...');
      const industryInsights = await this.searchForIndustryInsights(industry, keywords);
      results.industryInsights = industryInsights;
      logger.success(`Found ${industryInsights.length} industry insights`);

      await sleep(500);

      // Step 4: Search for competitor/market info
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
   * Search for professional subspecialties and risk profiles
   * This is CRITICAL for generating accurate, industry-specific personas
   */
  private async searchForSubspecialties(
    topic: string,
    industry: string
  ): Promise<{ subspecialties: SubspecialtyInfo[]; riskResults: SearchResult[] }> {
    const subspecialties: SubspecialtyInfo[] = [];
    const riskResults: SearchResult[] = [];

    // Extract the profession from the topic (e.g., "pathologist" from "pathologist malpractice insurance")
    const profession = this.extractProfession(topic, industry);
    logger.info(`Researching subspecialties for profession: ${profession}`);

    // Search queries for finding subspecialties
    const subspecialtyQueries = [
      `types of ${profession}`,
      `${profession} subspecialties`,
      `${profession} specializations`,
      `different kinds of ${profession}`,
      `${profession} specialty areas`,
    ];

    // Search queries for risk profiles
    const riskQueries = [
      `${profession} malpractice risk`,
      `high risk ${profession} specialties`,
      `${profession} liability claims`,
      `${profession} insurance risk factors`,
      `${profession} common lawsuits`,
    ];

    // Search for subspecialties
    for (const query of subspecialtyQueries.slice(0, 3)) {
      try {
        await sleep(300);
        const results = await this.performSearch(query);

        // Extract subspecialty information from results
        const extracted = this.extractSubspecialtiesFromResults(results, profession);
        for (const sub of extracted) {
          // Avoid duplicates
          if (!subspecialties.find(s => s.name.toLowerCase() === sub.name.toLowerCase())) {
            subspecialties.push(sub);
          }
        }
      } catch (error) {
        logger.debug(`Subspecialty search failed for: ${query}`);
      }
    }

    // Search for risk profiles
    for (const query of riskQueries.slice(0, 3)) {
      try {
        await sleep(300);
        const results = await this.performSearch(query);
        riskResults.push(...results.slice(0, 5));

        // Enhance subspecialties with risk information
        this.enrichSubspecialtiesWithRisk(subspecialties, results);
      } catch (error) {
        logger.debug(`Risk search failed for: ${query}`);
      }
    }

    return { subspecialties, riskResults: this.deduplicateResults(riskResults) };
  }

  /**
   * Extract profession name from topic/industry
   */
  private extractProfession(topic: string, industry: string): string {
    // Common patterns to extract profession
    const combined = `${topic} ${industry}`.toLowerCase();

    // Try to find profession keywords
    const professionPatterns = [
      /(\w+ologist)/i,  // pathologist, radiologist, etc.
      /(\w+ist)/i,      // dentist, therapist, etc.
      /(\w+or)/i,       // doctor, contractor, etc.
      /(\w+er)/i,       // lawyer, teacher, etc.
      /(\w+ian)/i,      // physician, technician, etc.
    ];

    for (const pattern of professionPatterns) {
      const match = combined.match(pattern);
      if (match) {
        return match[1];
      }
    }

    // Fallback: use the first significant word from topic
    const words = topic.split(/\s+/).filter(w => w.length > 3);
    return words[0] || 'professional';
  }

  /**
   * Extract subspecialty information from search results
   */
  private extractSubspecialtiesFromResults(results: SearchResult[], profession: string): SubspecialtyInfo[] {
    const subspecialties: SubspecialtyInfo[] = [];
    const foundNames = new Set<string>();

    // Patterns to find subspecialty names
    const patterns = [
      new RegExp(`(\\w+${profession})`, 'gi'),  // dermatopathologist, cytopathologist
      new RegExp(`(\\w+)\\s+${profession}`, 'gi'),  // surgical pathologist
      new RegExp(`${profession}\\s+(\\w+)`, 'gi'),  // pathologist assistant
      /(\w+ology)\s/gi,  // dermatopathology, cytopathology
    ];

    for (const result of results) {
      const text = `${result.title} ${result.snippet}`;

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const name = match[1] || match[0];
          const cleanName = name.trim();

          // Filter out common words and already found names
          if (cleanName.length > 4 &&
              !foundNames.has(cleanName.toLowerCase()) &&
              !['the', 'and', 'for', 'with', 'that', 'this'].includes(cleanName.toLowerCase())) {
            foundNames.add(cleanName.toLowerCase());
            subspecialties.push({
              name: this.capitalize(cleanName),
              description: result.snippet.substring(0, 200),
              riskFactors: [],
              commonConcerns: [],
            });
          }
        }
      }
    }

    return subspecialties.slice(0, 10); // Limit to top 10
  }

  /**
   * Enrich subspecialties with risk information from search results
   */
  private enrichSubspecialtiesWithRisk(subspecialties: SubspecialtyInfo[], riskResults: SearchResult[]): void {
    for (const sub of subspecialties) {
      const subNameLower = sub.name.toLowerCase();

      for (const result of riskResults) {
        const textLower = `${result.title} ${result.snippet}`.toLowerCase();

        if (textLower.includes(subNameLower)) {
          // Extract risk factors from the snippet
          const riskKeywords = ['high risk', 'liability', 'claims', 'lawsuit', 'malpractice', 'error', 'misdiagnosis'];
          for (const keyword of riskKeywords) {
            if (textLower.includes(keyword) && !sub.riskFactors.includes(keyword)) {
              sub.riskFactors.push(keyword);
            }
          }

          // Add concern based on snippet
          if (result.snippet.length > 20 && sub.commonConcerns.length < 3) {
            sub.commonConcerns.push(result.snippet.substring(0, 150));
          }
        }
      }
    }
  }

  /**
   * Search for "People Also Ask" style questions - now including subspecialty-specific questions
   */
  private async searchForPAAQuestions(
    topic: string,
    industry: string,
    keywords: string[],
    subspecialties: SubspecialtyInfo[]
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

    // Add subspecialty-specific queries
    for (const sub of subspecialties.slice(0, 3)) {
      searchQueries.push(`${sub.name} insurance questions`);
      searchQueries.push(`${sub.name} malpractice concerns`);
    }

    for (const query of searchQueries.slice(0, 8)) { // Increased limit
      try {
        await sleep(300);
        const results = await this.performSearch(query);
        const questions = this.extractQuestionsFromResults(results, query);
        allQuestions.push(...questions);
      } catch (error) {
        logger.debug(`Search failed for query: ${query}`);
      }
    }

    // Deduplicate questions
    const uniqueQuestions = this.deduplicateQuestions(allQuestions);
    return uniqueQuestions.slice(0, 30); // Return top 30 questions
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

    $('.result').each((_, element) => {
      const titleEl = $(element).find('.result__title a');
      const snippetEl = $(element).find('.result__snippet');

      const title = titleEl.text().trim();
      const url = titleEl.attr('href') || '';
      const snippet = snippetEl.text().trim();

      if (title && snippet) {
        let cleanUrl = url;
        if (url.includes('uddg=')) {
          const match = url.match(/uddg=([^&]+)/);
          if (match) {
            cleanUrl = decodeURIComponent(match[1]);
          }
        }

        results.push({ title, url: cleanUrl, snippet });
      }
    });

    return results;
  }

  /**
   * Extract questions from search results
   */
  private extractQuestionsFromResults(results: SearchResult[], sourceQuery: string): PAAResult[] {
    const questions: PAAResult[] = [];

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
            if (!question.endsWith('?')) {
              question += '?';
            }
            question = question.charAt(0).toUpperCase() + question.slice(1);

            if (question.length > 15 && question.length < 150) {
              questions.push({ question, source: sourceQuery });
            }
          }
        }
      }

      // Check if title itself is a question
      if (result.title.includes('?') ||
          result.title.toLowerCase().startsWith('what') ||
          result.title.toLowerCase().startsWith('how') ||
          result.title.toLowerCase().startsWith('why')) {
        let question = result.title.trim();
        if (!question.endsWith('?')) {
          question += '?';
        }
        questions.push({ question, source: sourceQuery });
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
      const normalized = q.question.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

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
   * Check if two strings are similar
   */
  private isSimilar(a: string, b: string): boolean {
    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size > 0.7;
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

    for (const paa of data.paaQuestions) {
      const words = paa.question.toLowerCase()
        .replace(/[?.,!]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 4);
      words.forEach(w => topics.add(w));
    }

    for (const result of [...data.industryInsights, ...data.competitorInfo]) {
      const words = result.title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 4);
      words.slice(0, 3).forEach(w => topics.add(w));
    }

    // Add subspecialty names as topics
    for (const sub of data.subspecialties) {
      topics.add(sub.name.toLowerCase());
    }

    return Array.from(topics).slice(0, 30);
  }

  /**
   * Capitalize first letter
   */
  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

export function createWebSearchService(): WebSearchService {
  return new WebSearchService();
}
