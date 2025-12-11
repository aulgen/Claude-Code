/**
 * Persona Generator Agent
 *
 * This agent creates detailed user personas based on:
 * 1. Website analysis data
 * 2. People Also Ask questions
 * 3. Target audience insights
 *
 * Output: 5 distinct personas with demographics, behaviors, pain points, and goals
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  AgentConfig,
  AgentResponse,
  Persona,
  PersonaGeneratorInput,
  PersonaGeneratorOutput,
  WebsiteAnalysis,
  PeopleAlsoAskQuestion,
} from '../types';
import { createLogger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { generateSimpleId, retryWithBackoff, extractJson, safeJsonParse } from '../utils/helpers';

const logger = createLogger('PersonaGeneratorAgent');

export class PersonaGeneratorAgent {
  private config: AgentConfig;
  private anthropic: Anthropic;

  constructor() {
    const appConfig = getConfig();
    this.config = {
      name: 'Persona Generator Agent',
      description: 'Creates detailed user personas based on website research',
      model: appConfig.anthropic.model,
      maxTokens: 8192,
      temperature: 0.7,
    };
    this.anthropic = new Anthropic({
      apiKey: appConfig.anthropic.apiKey,
    });
  }

  /**
   * Main execution method
   */
  async execute(input: PersonaGeneratorInput): Promise<AgentResponse<PersonaGeneratorOutput>> {
    logger.section('Persona Generator Agent');
    const numberOfPersonas = input.numberOfPersonas || 5;
    logger.info(`Generating ${numberOfPersonas} personas...`);

    try {
      // Generate personas using Claude
      const personas = await this.generatePersonas(
        input.websiteAnalysis,
        input.peopleAlsoAsk,
        input.sampleOutputs,
        numberOfPersonas
      );

      // CRITICAL: Validate that we actually generated personas
      if (!personas || personas.length === 0) {
        logger.error('No personas were generated - cannot proceed');
        return {
          success: false,
          error: 'Failed to generate personas. The AI response could not be parsed into valid personas.',
        };
      }

      // Warn if we got fewer personas than requested
      if (personas.length < numberOfPersonas) {
        logger.warn(`Only generated ${personas.length} of ${numberOfPersonas} requested personas`);
      }

      // Generate rationale for persona selection
      const rationale = await this.generateRationale(personas, input.websiteAnalysis);

      const result: PersonaGeneratorOutput = {
        personas,
        rationale,
      };

      logger.success(`Generated ${personas.length} unique personas`);

      return {
        success: true,
        data: result,
        metadata: {
          personaCount: personas.length,
          journeyStages: this.countJourneyStages(personas),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('Persona generation failed', error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Generate personas using Claude
   */
  private async generatePersonas(
    analysis: WebsiteAnalysis,
    paaQuestions: PeopleAlsoAskQuestion[],
    sampleOutputs?: string[],
    count: number = 5
  ): Promise<Persona[]> {
    const prompt = this.buildPersonaPrompt(analysis, paaQuestions, sampleOutputs, count);
    const response = await this.callClaude(prompt);
    const jsonStr = extractJson(response) || response;

    const rawPersonas = safeJsonParse<Partial<Persona>[]>(jsonStr, []);

    // Process and validate personas
    return rawPersonas.slice(0, count).map((raw, index) => this.validateAndEnrichPersona(raw, index));
  }

  /**
   * Build the prompt for persona generation
   */
  private buildPersonaPrompt(
    analysis: WebsiteAnalysis,
    paaQuestions: PeopleAlsoAskQuestion[],
    sampleOutputs?: string[],
    count: number = 5
  ): string {
    const paaContext = paaQuestions
      .slice(0, 15)
      .map(q => `- ${q.question} (${q.searchIntent})`)
      .join('\n');

    const sampleContext = sampleOutputs && sampleOutputs.length > 0
      ? `\n\nSample outputs/content style to consider:\n${sampleOutputs.join('\n\n')}`
      : '';

    return `You are an expert user researcher and marketing strategist. Based on the following website analysis, create ${count} detailed and distinct user personas.

## Website Analysis

**Website:** ${analysis.title}
**Industry:** ${analysis.industryContext}
**Description:** ${analysis.description}

**Main Topics:** ${analysis.mainTopics.join(', ')}
**Target Audience Segments:** ${analysis.targetAudience.join(', ')}
**Products/Services:** ${[...analysis.keyProducts || [], ...analysis.keyServices || []].join(', ')}
**Unique Value Props:** ${analysis.uniqueSellingPoints.join(', ')}
**Brand Voice:** ${analysis.brandVoice}
**Content Themes:** ${analysis.contentThemes.join(', ')}

## People Also Ask Questions

${paaContext}
${sampleContext}

## Instructions

Create ${count} diverse personas that represent different segments of the target audience. Each persona should be unique in:
1. Demographics and background
2. Journey stage (awareness, consideration, decision, retention)
3. Pain points and challenges
4. Goals and motivations
5. Content preferences

Ensure diversity in:
- Age ranges and life stages
- Professional backgrounds
- Technical sophistication levels
- Decision-making authority
- Geographic considerations (if applicable)

Return a JSON array with exactly ${count} personas using this structure:
[
  {
    "name": "A realistic first and last name",
    "title": "A descriptive persona title (e.g., 'The Tech-Savvy Manager')",
    "bio": "A 2-3 sentence biography describing who this person is",
    "demographics": {
      "ageRange": "e.g., '35-44'",
      "occupation": "Job title and industry",
      "location": "Geographic location type (e.g., 'Urban, East Coast US')",
      "educationLevel": "Highest education level",
      "incomeLevel": "Income bracket (optional)"
    },
    "behavior": {
      "onlineHabits": ["Array of 3-5 online behaviors"],
      "preferredChannels": ["Array of 3-5 preferred communication/content channels"],
      "decisionMakingStyle": "How they make decisions",
      "informationSources": ["Array of 3-5 sources they trust"]
    },
    "painPoints": {
      "challenges": ["Array of 3-5 main challenges"],
      "frustrations": ["Array of 3-5 frustrations"],
      "unmetNeeds": ["Array of 2-3 unmet needs"]
    },
    "goals": {
      "primaryGoals": ["Array of 2-3 primary goals"],
      "secondaryGoals": ["Array of 2-3 secondary goals"],
      "motivations": ["Array of 3-4 underlying motivations"]
    },
    "typicalQuestions": ["Array of 5-7 questions this persona would ask"],
    "preferredContentFormat": ["Array of 3-5 content formats they prefer"],
    "journeyStage": "awareness|consideration|decision|retention"
  }
]

Return ONLY the JSON array, no additional text or explanation.`;
  }

  /**
   * Validate and enrich a persona with defaults
   */
  private validateAndEnrichPersona(raw: Partial<Persona>, index: number): Persona {
    const id = generateSimpleId();

    return {
      id,
      name: raw.name || `Persona ${index + 1}`,
      title: raw.title || 'User Persona',
      bio: raw.bio || 'A typical user of the website.',
      demographics: {
        ageRange: raw.demographics?.ageRange || '25-54',
        occupation: raw.demographics?.occupation || 'Professional',
        location: raw.demographics?.location || 'United States',
        educationLevel: raw.demographics?.educationLevel || 'Bachelor\'s degree',
        incomeLevel: raw.demographics?.incomeLevel,
      },
      behavior: {
        onlineHabits: raw.behavior?.onlineHabits || ['Uses search engines', 'Reads reviews'],
        preferredChannels: raw.behavior?.preferredChannels || ['Email', 'Website'],
        decisionMakingStyle: raw.behavior?.decisionMakingStyle || 'Research-driven',
        informationSources: raw.behavior?.informationSources || ['Google', 'Industry publications'],
      },
      painPoints: {
        challenges: raw.painPoints?.challenges || ['Finding reliable information'],
        frustrations: raw.painPoints?.frustrations || ['Unclear pricing'],
        unmetNeeds: raw.painPoints?.unmetNeeds || ['Better customer support'],
      },
      goals: {
        primaryGoals: raw.goals?.primaryGoals || ['Solve their problem'],
        secondaryGoals: raw.goals?.secondaryGoals || ['Save time'],
        motivations: raw.goals?.motivations || ['Efficiency', 'Quality'],
      },
      typicalQuestions: raw.typicalQuestions || ['How does this work?', 'What are the benefits?'],
      preferredContentFormat: raw.preferredContentFormat || ['Articles', 'Videos'],
      journeyStage: raw.journeyStage || 'consideration',
      createdAt: new Date(),
    };
  }

  /**
   * Generate rationale for persona selection
   */
  private async generateRationale(personas: Persona[], analysis: WebsiteAnalysis): Promise<string> {
    const personaSummaries = personas.map((p, i) =>
      `${i + 1}. ${p.name} (${p.title}) - ${p.journeyStage} stage`
    ).join('\n');

    const prompt = `Provide a brief 2-3 paragraph rationale explaining why these ${personas.length} personas were chosen for ${analysis.title}.

Personas created:
${personaSummaries}

Website context:
- Industry: ${analysis.industryContext}
- Target audiences: ${analysis.targetAudience.join(', ')}

Explain how these personas:
1. Cover the key audience segments
2. Represent different stages of the customer journey
3. Address the diversity of needs and pain points

Keep the response concise (150-200 words).`;

    return await this.callClaude(prompt);
  }

  /**
   * Count personas by journey stage
   */
  private countJourneyStages(personas: Persona[]): Record<string, number> {
    const counts: Record<string, number> = {
      awareness: 0,
      consideration: 0,
      decision: 0,
      retention: 0,
    };

    personas.forEach(p => {
      if (counts[p.journeyStage] !== undefined) {
        counts[p.journeyStage]++;
      }
    });

    return counts;
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
          temperature: this.config.temperature || 0.7,
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
   * Format a persona for display or export
   */
  formatPersonaForExport(persona: Persona): string {
    return `# ${persona.name}
## ${persona.title}

### Bio
${persona.bio}

### Demographics
- **Age Range:** ${persona.demographics.ageRange}
- **Occupation:** ${persona.demographics.occupation}
- **Location:** ${persona.demographics.location}
- **Education:** ${persona.demographics.educationLevel}
${persona.demographics.incomeLevel ? `- **Income Level:** ${persona.demographics.incomeLevel}` : ''}

### Journey Stage
${persona.journeyStage.charAt(0).toUpperCase() + persona.journeyStage.slice(1)}

### Online Behavior
- **Online Habits:** ${persona.behavior.onlineHabits.join(', ')}
- **Preferred Channels:** ${persona.behavior.preferredChannels.join(', ')}
- **Decision Making Style:** ${persona.behavior.decisionMakingStyle}
- **Information Sources:** ${persona.behavior.informationSources.join(', ')}

### Pain Points
**Challenges:**
${persona.painPoints.challenges.map(c => `- ${c}`).join('\n')}

**Frustrations:**
${persona.painPoints.frustrations.map(f => `- ${f}`).join('\n')}

**Unmet Needs:**
${persona.painPoints.unmetNeeds.map(n => `- ${n}`).join('\n')}

### Goals
**Primary Goals:**
${persona.goals.primaryGoals.map(g => `- ${g}`).join('\n')}

**Secondary Goals:**
${persona.goals.secondaryGoals.map(g => `- ${g}`).join('\n')}

**Motivations:**
${persona.goals.motivations.map(m => `- ${m}`).join('\n')}

### Typical Questions
${persona.typicalQuestions.map(q => `- ${q}`).join('\n')}

### Preferred Content Formats
${persona.preferredContentFormat.join(', ')}

---
*Generated on ${persona.createdAt.toISOString()}*
`;
  }
}

export function createPersonaGeneratorAgent(): PersonaGeneratorAgent {
  return new PersonaGeneratorAgent();
}
