/**
 * Fact Checker Agent
 *
 * This agent verifies the accuracy of FAQ content by:
 * 1. Extracting factual claims from FAQ answers
 * 2. Attempting to verify claims against source website and web searches
 * 3. Providing verification status and confidence scores
 * 4. Generating recommendations for content amendments or removal
 *
 * Output: Comprehensive fact-check report with sources and recommendations
 */

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import * as cheerio from 'cheerio';
import {
  AgentConfig,
  AgentResponse,
  FAQItem,
  FactCheckReport,
  FactCheckResult,
  FactCheckRecommendation,
  ClaimVerification,
  VerificationSource,
  VerificationStatus,
  RecommendationAction,
  FactCheckerInput,
} from '../types';
import { createLogger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { retryWithBackoff, extractJson, safeJsonParse, truncate, cleanText } from '../utils/helpers';

const logger = createLogger('FactCheckerAgent');

interface ExtractedClaim {
  claim: string;
  type: 'factual' | 'statistical' | 'procedural' | 'opinion';
  checkable: boolean;
}

interface RawVerificationResult {
  status: string;
  confidence: number;
  explanation: string;
  suggestedAction: string;
  suggestedChanges?: string;
  reasoning: string;
}

export class FactCheckerAgent {
  private config: AgentConfig;
  private anthropic: Anthropic;
  private sourceCache: Map<string, string>;

  constructor() {
    const appConfig = getConfig();
    this.config = {
      name: 'Fact Checker Agent',
      description: 'Verifies FAQ content accuracy and provides recommendations',
      model: appConfig.anthropic.model,
      maxTokens: 4096,
      temperature: 0.2, // Lower temperature for more consistent fact-checking
    };
    this.anthropic = new Anthropic({
      apiKey: appConfig.anthropic.apiKey,
    });
    this.sourceCache = new Map();
  }

  /**
   * Main execution method
   */
  async execute(input: FactCheckerInput): Promise<AgentResponse<FactCheckReport>> {
    logger.section('Fact Checker Agent');
    logger.info(`Fact-checking ${input.faqs.length} FAQs...`);

    try {
      // Fetch source content for verification
      logger.info('Fetching source content for verification...');
      const sourceContent = await this.fetchSourceContent(input.websiteUrl);

      const results: FactCheckResult[] = [];
      let verifiedCount = 0;
      let partiallyVerifiedCount = 0;
      let unverifiedCount = 0;
      let falseCount = 0;
      let outdatedCount = 0;

      // Process each FAQ
      for (let i = 0; i < input.faqs.length; i++) {
        const faq = input.faqs[i];
        logger.progress('Fact-checking', i + 1, input.faqs.length, truncate(faq.question, 40));

        const result = await this.factCheckFAQ(faq, sourceContent, input.websiteUrl);
        results.push(result);

        // Update counters
        const overallStatus = this.determineOverallStatus(result.claims);
        switch (overallStatus) {
          case 'verified':
            verifiedCount++;
            break;
          case 'partially_verified':
            partiallyVerifiedCount++;
            break;
          case 'unverified':
            unverifiedCount++;
            break;
          case 'false':
            falseCount++;
            break;
          case 'outdated':
            outdatedCount++;
            break;
        }
      }

      // Generate summary
      const summary = await this.generateSummary(results, input.faqs.length);

      const report: FactCheckReport = {
        totalFAQsChecked: input.faqs.length,
        verifiedCount,
        partiallyVerifiedCount,
        unverifiedCount,
        falseCount,
        outdatedCount,
        results,
        summary,
        generatedAt: new Date(),
      };

      logger.success('Fact-checking complete');
      logger.info(`Results: ${verifiedCount} verified, ${partiallyVerifiedCount} partially verified, ${unverifiedCount} unverified, ${falseCount} false, ${outdatedCount} outdated`);

      return {
        success: true,
        data: report,
        metadata: {
          totalChecked: input.faqs.length,
          verificationRate: (verifiedCount + partiallyVerifiedCount) / input.faqs.length,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('Fact-checking failed', error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Fetch source content from the website
   */
  private async fetchSourceContent(url: string): Promise<string> {
    if (this.sourceCache.has(url)) {
      return this.sourceCache.get(url)!;
    }

    try {
      const response = await retryWithBackoff(
        async () => {
          return axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html,application/xhtml+xml',
            },
            timeout: 30000,
          });
        },
        3,
        2000
      );

      const $ = cheerio.load(response.data);
      $('script, style, noscript, iframe, nav, footer').remove();
      const content = cleanText($('body').text());
      this.sourceCache.set(url, content);
      return content;
    } catch (error) {
      logger.warn(`Could not fetch source content from ${url}`);
      return '';
    }
  }

  /**
   * Fact-check a single FAQ
   */
  private async factCheckFAQ(
    faq: FAQItem,
    sourceContent: string,
    websiteUrl: string
  ): Promise<FactCheckResult> {
    // Step 1: Extract claims from the answer
    const claims = await this.extractClaims(faq.answer);

    // Step 2: Verify each claim
    const verifiedClaims: ClaimVerification[] = [];
    for (const claim of claims) {
      if (claim.checkable) {
        const verification = await this.verifyClaim(claim, sourceContent, websiteUrl, faq.question);
        verifiedClaims.push(verification);
      }
    }

    // Step 3: Calculate overall verification score
    const overallScore = this.calculateOverallScore(verifiedClaims);

    // Step 4: Generate recommendation
    const recommendation = await this.generateRecommendation(
      faq,
      verifiedClaims,
      overallScore
    );

    return {
      faqId: faq.id,
      question: faq.question,
      originalAnswer: faq.answer,
      claims: verifiedClaims,
      overallVerificationScore: overallScore,
      recommendation,
    };
  }

  /**
   * Extract factual claims from text
   */
  private async extractClaims(answer: string): Promise<ExtractedClaim[]> {
    const prompt = `Analyze this FAQ answer and extract distinct factual claims that can be verified.

Answer:
"${answer}"

For each claim, determine:
1. The specific claim being made
2. The type: factual (general fact), statistical (numbers/data), procedural (how-to), or opinion (subjective)
3. Whether it can be objectively verified (checkable: true/false)

Return a JSON array:
[
  {
    "claim": "The specific claim text",
    "type": "factual|statistical|procedural|opinion",
    "checkable": true|false
  }
]

Focus on:
- Specific facts that can be verified
- Statistics or numerical claims
- Claims about how things work
- Skip obvious opinions or subjective statements

Return ONLY the JSON array.`;

    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;
    return safeJsonParse<ExtractedClaim[]>(jsonStr, []);
  }

  /**
   * Verify a single claim
   */
  private async verifyClaim(
    claim: ExtractedClaim,
    sourceContent: string,
    websiteUrl: string,
    questionContext: string
  ): Promise<ClaimVerification> {
    const prompt = `You are a fact-checker. Verify this claim using the provided source content.

**Claim to verify:** "${claim.claim}"
**Claim type:** ${claim.type}
**Question context:** ${questionContext}
**Source URL:** ${websiteUrl}

**Source Content (from the website):**
${truncate(sourceContent, 8000)}

Analyze whether this claim is:
1. **verified** - Claim is supported by the source content
2. **partially_verified** - Some aspects are supported, but not all
3. **unverified** - Cannot find evidence to support or refute
4. **false** - Claim contradicts the source content
5. **outdated** - Information may have changed or be time-sensitive

Return a JSON object:
{
  "status": "verified|partially_verified|unverified|false|outdated",
  "confidence": 0.0-1.0,
  "explanation": "Detailed explanation of the verification result",
  "foundEvidence": "Quote or paraphrase from source that supports/refutes the claim, or 'No direct evidence found'",
  "sourceRelevance": "How relevant the source content is to this claim"
}

Return ONLY the JSON object.`;

    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;
    const result = safeJsonParse<{
      status: string;
      confidence: number;
      explanation: string;
      foundEvidence: string;
      sourceRelevance: string;
    }>(jsonStr, {
      status: 'unverified',
      confidence: 0.5,
      explanation: 'Could not verify claim',
      foundEvidence: 'No evidence found',
      sourceRelevance: 'Unknown',
    });

    // Create source reference
    const sources: VerificationSource[] = [];
    if (result.foundEvidence && result.foundEvidence !== 'No direct evidence found') {
      sources.push({
        url: websiteUrl,
        title: 'Source Website',
        snippet: result.foundEvidence,
        credibilityScore: 0.8,
        accessedAt: new Date(),
      });
    }

    return {
      claim: claim.claim,
      status: this.validateStatus(result.status),
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
      sources,
      explanation: result.explanation,
    };
  }

  /**
   * Validate verification status
   */
  private validateStatus(status: string): VerificationStatus {
    const valid: VerificationStatus[] = ['verified', 'partially_verified', 'unverified', 'false', 'outdated'];
    return valid.includes(status as VerificationStatus) ? status as VerificationStatus : 'unverified';
  }

  /**
   * Calculate overall verification score
   */
  private calculateOverallScore(claims: ClaimVerification[]): number {
    if (claims.length === 0) return 0.5;

    const statusScores: Record<VerificationStatus, number> = {
      verified: 1.0,
      partially_verified: 0.7,
      unverified: 0.5,
      outdated: 0.3,
      false: 0.0,
    };

    const totalScore = claims.reduce((sum, claim) => {
      const statusScore = statusScores[claim.status];
      return sum + (statusScore * claim.confidence);
    }, 0);

    return totalScore / claims.length;
  }

  /**
   * Determine overall status from claims
   */
  private determineOverallStatus(claims: ClaimVerification[]): VerificationStatus {
    if (claims.length === 0) return 'unverified';

    const statusCounts: Record<VerificationStatus, number> = {
      verified: 0,
      partially_verified: 0,
      unverified: 0,
      false: 0,
      outdated: 0,
    };

    claims.forEach(claim => {
      statusCounts[claim.status]++;
    });

    // If any claim is false, overall is false
    if (statusCounts.false > 0) return 'false';

    // If any claim is outdated, overall is outdated
    if (statusCounts.outdated > 0) return 'outdated';

    // If majority is verified
    if (statusCounts.verified > claims.length / 2) return 'verified';

    // If mix of verified and partially verified
    if (statusCounts.verified + statusCounts.partially_verified > claims.length / 2) {
      return 'partially_verified';
    }

    return 'unverified';
  }

  /**
   * Generate recommendation for an FAQ
   */
  private async generateRecommendation(
    faq: FAQItem,
    claims: ClaimVerification[],
    overallScore: number
  ): Promise<FactCheckRecommendation> {
    const claimsSummary = claims.map(c =>
      `- "${truncate(c.claim, 100)}": ${c.status} (${Math.round(c.confidence * 100)}%)`
    ).join('\n');

    const prompt = `Based on the fact-check results, provide a recommendation for this FAQ.

**Question:** ${faq.question}

**Original Answer:** ${faq.answer}

**Verification Results:**
${claimsSummary}

**Overall Score:** ${Math.round(overallScore * 100)}%

Provide a recommendation:
{
  "action": "keep|amend|remove|needs_review",
  "suggestedChanges": "If action is 'amend', provide the specific changes needed. Otherwise null.",
  "reasoning": "Explain why this recommendation is made",
  "priority": "critical|important|minor"
}

Guidelines:
- "keep": Score >= 0.8 and no false claims
- "amend": Score 0.5-0.8 or has partially verified claims
- "remove": Score < 0.3 or has false claims
- "needs_review": Has unverified claims that require human verification

Return ONLY the JSON object.`;

    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;
    const result = safeJsonParse<RawVerificationResult>(jsonStr, {
      status: 'needs_review',
      confidence: 0.5,
      explanation: '',
      suggestedAction: 'needs_review',
      reasoning: 'Unable to generate recommendation',
    });

    return {
      action: this.validateAction(result.suggestedAction),
      suggestedChanges: result.suggestedChanges,
      reasoning: result.reasoning,
      priority: this.determinePriority(overallScore, claims),
    };
  }

  /**
   * Validate recommendation action
   */
  private validateAction(action: string): RecommendationAction {
    const valid: RecommendationAction[] = ['keep', 'amend', 'remove', 'needs_review'];
    return valid.includes(action as RecommendationAction) ? action as RecommendationAction : 'needs_review';
  }

  /**
   * Determine recommendation priority
   */
  private determinePriority(score: number, claims: ClaimVerification[]): 'critical' | 'important' | 'minor' {
    // False claims are critical
    if (claims.some(c => c.status === 'false')) return 'critical';

    // Low score is important
    if (score < 0.5) return 'important';

    // Medium score is minor
    if (score < 0.8) return 'minor';

    return 'minor';
  }

  /**
   * Generate summary report
   */
  private async generateSummary(results: FactCheckResult[], totalFAQs: number): Promise<string> {
    const criticalIssues = results.filter(r => r.recommendation.priority === 'critical');
    const importantIssues = results.filter(r => r.recommendation.priority === 'important');

    const prompt = `Generate a brief executive summary of this fact-check report.

Total FAQs checked: ${totalFAQs}
Critical issues: ${criticalIssues.length}
Important issues: ${importantIssues.length}

Key findings:
${results.slice(0, 5).map(r =>
  `- "${truncate(r.question, 50)}": Score ${Math.round(r.overallVerificationScore * 100)}%, Action: ${r.recommendation.action}`
).join('\n')}

Write a 2-3 paragraph summary that:
1. Highlights the overall quality of the FAQ content
2. Identifies patterns in verification issues
3. Provides actionable recommendations

Keep it concise and professional.`;

    return await this.callClaude(prompt);
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
          temperature: this.config.temperature || 0.2,
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
   * Format fact-check report for export
   */
  formatReportForExport(report: FactCheckReport): string {
    let output = `# Fact-Check Report\n\n`;
    output += `*Generated on ${report.generatedAt.toISOString()}*\n\n`;

    output += `## Summary Statistics\n\n`;
    output += `| Metric | Count |\n`;
    output += `|--------|-------|\n`;
    output += `| Total FAQs Checked | ${report.totalFAQsChecked} |\n`;
    output += `| Verified | ${report.verifiedCount} |\n`;
    output += `| Partially Verified | ${report.partiallyVerifiedCount} |\n`;
    output += `| Unverified | ${report.unverifiedCount} |\n`;
    output += `| False | ${report.falseCount} |\n`;
    output += `| Outdated | ${report.outdatedCount} |\n\n`;

    output += `## Executive Summary\n\n${report.summary}\n\n`;

    output += `---\n\n## Detailed Results\n\n`;

    report.results.forEach((result, index) => {
      output += `### ${index + 1}. ${result.question}\n\n`;
      output += `**Verification Score:** ${Math.round(result.overallVerificationScore * 100)}%\n\n`;

      output += `**Claims Analyzed:**\n`;
      result.claims.forEach(claim => {
        const statusEmoji = {
          verified: '✓',
          partially_verified: '◐',
          unverified: '?',
          false: '✗',
          outdated: '⏰',
        }[claim.status];
        output += `- ${statusEmoji} ${claim.claim}\n`;
        output += `  - Status: ${claim.status} (${Math.round(claim.confidence * 100)}% confidence)\n`;
        output += `  - ${claim.explanation}\n`;
        if (claim.sources.length > 0) {
          output += `  - Sources: ${claim.sources.map(s => s.url).join(', ')}\n`;
        }
      });

      output += `\n**Recommendation:** ${result.recommendation.action.toUpperCase()}\n`;
      output += `- Priority: ${result.recommendation.priority}\n`;
      output += `- Reasoning: ${result.recommendation.reasoning}\n`;
      if (result.recommendation.suggestedChanges) {
        output += `- Suggested Changes: ${result.recommendation.suggestedChanges}\n`;
      }

      output += `\n---\n\n`;
    });

    return output;
  }
}

export function createFactCheckerAgent(): FactCheckerAgent {
  return new FactCheckerAgent();
}
