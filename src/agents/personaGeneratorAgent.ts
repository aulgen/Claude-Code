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
  SubspecialtyInfo,
} from '../types';
import { createLogger } from '../utils/logger';
import { getConfig } from '../utils/config';
import { generateSimpleId, retryWithBackoff, extractJson, safeJsonParse } from '../utils/helpers';

const logger = createLogger('PersonaGeneratorAgent');

// Maximum number of retry attempts for persona generation
const MAX_GENERATION_ATTEMPTS = 3;

interface ExtractedPersonaDefinition {
  name: string;
  type: string;
  description: string;
  concerns: string[];
}

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
      let personas: Persona[];

      // Step 1: Try to extract predefined personas from sample outputs
      if (input.sampleOutputs && input.sampleOutputs.length > 0) {
        logger.info('Checking sample outputs for predefined persona definitions...');
        const extractedDefinitions = await this.extractPredefinedPersonas(input.sampleOutputs);

        if (extractedDefinitions.length > 0) {
          logger.success(`Found ${extractedDefinitions.length} predefined persona definitions in sample content`);
          // Convert extracted definitions to full personas
          personas = await this.generatePersonasFromDefinitions(
            extractedDefinitions,
            input.websiteAnalysis,
            input.peopleAlsoAsk
          );
        } else {
          logger.info('No predefined personas found, generating based on research...');
          personas = await this.generatePersonas(
            input.websiteAnalysis,
            input.peopleAlsoAsk,
            input.sampleOutputs,
            numberOfPersonas,
            input.subspecialties
          );
        }
      } else {
        // No sample outputs - generate personas using subspecialty data
        logger.info('Generating personas using web research and subspecialty data...');
        personas = await this.generatePersonas(
          input.websiteAnalysis,
          input.peopleAlsoAsk,
          input.sampleOutputs,
          numberOfPersonas,
          input.subspecialties
        );
      }

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
   * Extract predefined persona definitions from sample content using AI
   */
  private async extractPredefinedPersonas(sampleOutputs: string[]): Promise<ExtractedPersonaDefinition[]> {
    const combinedSamples = sampleOutputs.join('\n\n---\n\n');

    const prompt = `Analyze the following content and extract any EXPLICITLY DEFINED personas or target audience segments.

Look for:
- Named personas (e.g., "Persona A", "Dr. Smith", etc.)
- Defined professional types or subspecialties (e.g., "dermatopathologist", "cytopathologist")
- Specific target audience segments with descriptions
- Any explicitly listed user types with their characteristics

CONTENT TO ANALYZE:
${combinedSamples.substring(0, 15000)}

If you find explicitly defined personas, return them as a JSON array:
[
  {
    "name": "Name or title of the persona",
    "type": "Professional type or subspecialty",
    "description": "Brief description of who they are",
    "concerns": ["List of their main concerns or needs"]
  }
]

If NO explicit personas are defined in the content, return an empty array: []

IMPORTANT: Only extract personas that are EXPLICITLY defined in the content. Do not infer or create new ones.
Return ONLY the JSON array.`;

    try {
      const response = await this.callClaude(prompt);
      const jsonStr = extractJson(response) || response;
      const definitions = safeJsonParse<ExtractedPersonaDefinition[]>(jsonStr, []);

      // Validate the extracted definitions
      return definitions.filter(d =>
        d && d.name && d.type && d.name.length > 0 && d.type.length > 0
      );
    } catch (error) {
      logger.debug(`Failed to extract personas: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /**
   * Generate full personas from extracted definitions
   */
  private async generatePersonasFromDefinitions(
    definitions: ExtractedPersonaDefinition[],
    analysis: WebsiteAnalysis,
    paaQuestions: PeopleAlsoAskQuestion[]
  ): Promise<Persona[]> {
    const definitionsContext = definitions
      .map((d, i) => `${i + 1}. ${d.name} (${d.type}): ${d.description}
   Concerns: ${d.concerns.join(', ')}`)
      .join('\n\n');

    const prompt = `You are creating detailed user personas based on PREDEFINED persona definitions.

These personas were EXPLICITLY defined in the source content - you MUST create personas for EACH of these:

${definitionsContext}

Website Context:
- Industry: ${analysis.industryContext}
- Main Topics: ${analysis.mainTopics.join(', ')}

Create a full persona for EACH of the ${definitions.length} predefined personas above.
Each persona must match the type and concerns specified.

Return a JSON array with exactly ${definitions.length} personas using this structure:
[
  {
    "name": "A realistic name that fits the persona type",
    "title": "The persona type from above (e.g., 'The Dermatopathologist')",
    "bio": "A 2-3 sentence biography incorporating their specific concerns",
    "demographics": {
      "ageRange": "Appropriate age range",
      "occupation": "Their specific professional role",
      "location": "Geographic location",
      "educationLevel": "Education level",
      "incomeLevel": "Income bracket"
    },
    "behavior": {
      "onlineHabits": ["3-5 behaviors"],
      "preferredChannels": ["3-5 channels"],
      "decisionMakingStyle": "How they decide",
      "informationSources": ["3-5 sources"]
    },
    "painPoints": {
      "challenges": ["Include the specific concerns from the definition"],
      "frustrations": ["3-5 frustrations"],
      "unmetNeeds": ["2-3 needs"]
    },
    "goals": {
      "primaryGoals": ["2-3 goals"],
      "secondaryGoals": ["2-3 goals"],
      "motivations": ["3-4 motivations"]
    },
    "typicalQuestions": ["5-7 questions they would ask"],
    "preferredContentFormat": ["3-5 formats"],
    "journeyStage": "awareness|consideration|decision|retention"
  }
]

CRITICAL: Create exactly ${definitions.length} personas, one for each predefined type. Return ONLY the JSON array.`;

    try {
      const response = await this.callClaude(prompt);
      const personas = this.parsePersonasFromResponse(response, definitions.length);

      if (personas.length === 0) {
        logger.warn('Failed to generate personas from definitions, falling back to standard generation');
        throw new Error('Failed to parse personas from definitions');
      }

      return personas;
    } catch (error) {
      logger.warn(`Error generating from definitions: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Generate personas using Claude with retry logic
   */
  private async generatePersonas(
    analysis: WebsiteAnalysis,
    paaQuestions: PeopleAlsoAskQuestion[],
    sampleOutputs?: string[],
    count: number = 5,
    subspecialties?: SubspecialtyInfo[]
  ): Promise<Persona[]> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      try {
        logger.info(`Persona generation attempt ${attempt}/${MAX_GENERATION_ATTEMPTS}`);

        const prompt = this.buildPersonaPrompt(analysis, paaQuestions, sampleOutputs, count, attempt > 1, subspecialties);
        const response = await this.callClaude(prompt);

        logger.debug(`Raw response length: ${response.length} characters`);

        // Try multiple JSON extraction strategies
        const personas = this.parsePersonasFromResponse(response, count);

        if (personas.length > 0) {
          logger.success(`Successfully parsed ${personas.length} personas on attempt ${attempt}`);
          return personas;
        }

        logger.warn(`Attempt ${attempt}: No personas could be parsed from response`);
        lastError = new Error('Failed to parse personas from response');

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`Attempt ${attempt} failed: ${lastError.message}`);
      }

      // Wait before retrying
      if (attempt < MAX_GENERATION_ATTEMPTS) {
        const delay = attempt * 1000;
        logger.info(`Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    // All attempts failed - throw the last error
    throw lastError || new Error('Failed to generate personas after all attempts');
  }

  /**
   * Parse personas from Claude's response using multiple strategies
   */
  private parsePersonasFromResponse(response: string, count: number): Persona[] {
    // Strategy 1: Try extracting JSON array directly
    const jsonStr = extractJson(response);
    if (jsonStr) {
      logger.debug('Strategy 1: Attempting to parse extracted JSON');
      const parsed = safeJsonParse<Partial<Persona>[]>(jsonStr, []);
      if (Array.isArray(parsed) && parsed.length > 0) {
        logger.debug(`Strategy 1 succeeded: Found ${parsed.length} personas`);
        return parsed.slice(0, count).map((raw, index) => this.validateAndEnrichPersona(raw, index));
      }
    }

    // Strategy 2: Try parsing the whole response as JSON
    logger.debug('Strategy 2: Attempting to parse entire response as JSON');
    const directParse = safeJsonParse<Partial<Persona>[]>(response.trim(), []);
    if (Array.isArray(directParse) && directParse.length > 0) {
      logger.debug(`Strategy 2 succeeded: Found ${directParse.length} personas`);
      return directParse.slice(0, count).map((raw, index) => this.validateAndEnrichPersona(raw, index));
    }

    // Strategy 3: Look for JSON between code fences
    logger.debug('Strategy 3: Looking for JSON in code fences');
    const codeFenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeFenceMatch) {
      const fencedContent = codeFenceMatch[1].trim();
      const fencedParse = safeJsonParse<Partial<Persona>[]>(fencedContent, []);
      if (Array.isArray(fencedParse) && fencedParse.length > 0) {
        logger.debug(`Strategy 3 succeeded: Found ${fencedParse.length} personas`);
        return fencedParse.slice(0, count).map((raw, index) => this.validateAndEnrichPersona(raw, index));
      }
    }

    // Strategy 4: Try to find individual persona objects
    logger.debug('Strategy 4: Attempting to find individual persona objects');
    const personaMatches = response.match(/\{[^{}]*"name"[^{}]*\}/g);
    if (personaMatches && personaMatches.length > 0) {
      const individualPersonas: Partial<Persona>[] = [];
      for (const match of personaMatches) {
        try {
          const parsed = JSON.parse(match) as Partial<Persona>;
          if (parsed && parsed.name) {
            individualPersonas.push(parsed);
          }
        } catch {
          // Skip invalid JSON
        }
      }
      if (individualPersonas.length > 0) {
        logger.debug(`Strategy 4 succeeded: Found ${individualPersonas.length} personas`);
        return individualPersonas.slice(0, count).map((raw, index) => this.validateAndEnrichPersona(raw, index));
      }
    }

    logger.warn('All parsing strategies failed');
    logger.debug(`Response preview (first 500 chars): ${response.substring(0, 500)}...`);
    return [];
  }

  /**
   * Build the prompt for persona generation
   */
  private buildPersonaPrompt(
    analysis: WebsiteAnalysis,
    paaQuestions: PeopleAlsoAskQuestion[],
    sampleOutputs?: string[],
    count: number = 5,
    isRetry: boolean = false,
    subspecialties?: SubspecialtyInfo[]
  ): string {
    // Build PAA context - handle empty arrays gracefully
    const paaContext = paaQuestions.length > 0
      ? paaQuestions
          .slice(0, 15)
          .map(q => `- ${q.question} (${q.searchIntent})`)
          .join('\n')
      : 'No specific questions available - infer typical questions based on the industry and target audience.';

    const sampleContext = sampleOutputs && sampleOutputs.length > 0
      ? `\n\nSample outputs/content style to consider:\n${sampleOutputs.join('\n\n')}`
      : '';

    // Build target audience context - handle empty arrays
    const targetAudienceStr = analysis.targetAudience.length > 0
      ? analysis.targetAudience.join(', ')
      : 'General audience interested in ' + analysis.industryContext;

    const productsServices = [...(analysis.keyProducts || []), ...(analysis.keyServices || [])];
    const productsServicesStr = productsServices.length > 0
      ? productsServices.join(', ')
      : 'Services related to ' + analysis.industryContext;

    const uniqueSellingPointsStr = analysis.uniqueSellingPoints.length > 0
      ? analysis.uniqueSellingPoints.join(', ')
      : 'Quality service and expertise in ' + analysis.industryContext;

    // Build subspecialty context - CRITICAL for industry-specific personas
    let subspecialtyContext = '';
    let subspecialtyInstructions = '';
    if (subspecialties && subspecialties.length > 0) {
      subspecialtyContext = `\n\n## Professional Subspecialties Discovered (IMPORTANT)

The following professional subspecialties/types were discovered through web research. You MUST create personas that represent DIFFERENT subspecialties to ensure comprehensive coverage:

${subspecialties.map((s, i) => `${i + 1}. **${s.name}**
   - Description: ${s.description.substring(0, 200)}
   - Risk factors: ${s.riskFactors.join(', ') || 'Various'}
   - Common concerns: ${s.commonConcerns.slice(0, 2).join('; ') || 'Industry-specific concerns'}`).join('\n\n')}
`;
      subspecialtyInstructions = `
**CRITICAL SUBSPECIALTY REQUIREMENT:**
- Each persona MUST represent a DIFFERENT professional subspecialty from the list above
- Do NOT create duplicate subspecialty personas
- Include the subspecialty in the persona's title (e.g., "The Dermatopathologist", "The Cytopathologist")
- Tailor their challenges, concerns, and questions to their specific subspecialty
- If you have more personas than subspecialties, create personas at different career stages (new practitioner, mid-career, retiring)
`;
    }

    // Add retry-specific instructions
    const retryInstructions = isRetry
      ? `\n\n**IMPORTANT**: This is a retry attempt. The previous response could not be parsed. Please ensure you return ONLY a valid JSON array with no additional text, markdown formatting, or code fences. Start your response directly with [ and end with ].`
      : '';

    return `You are an expert user researcher and marketing strategist. Based on the following website analysis, create ${count} detailed and distinct user personas.

## Website Analysis

**Website:** ${analysis.title || 'Website'}
**Industry:** ${analysis.industryContext || 'General'}
**Description:** ${analysis.description || 'A business website'}

**Main Topics:** ${analysis.mainTopics.length > 0 ? analysis.mainTopics.join(', ') : analysis.industryContext}
**Target Audience Segments:** ${targetAudienceStr}
**Products/Services:** ${productsServicesStr}
**Unique Value Props:** ${uniqueSellingPointsStr}
**Brand Voice:** ${analysis.brandVoice || 'Professional'}
**Content Themes:** ${analysis.contentThemes.length > 0 ? analysis.contentThemes.join(', ') : analysis.industryContext}
${subspecialtyContext}
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
${subspecialtyInstructions}
Ensure diversity in:
- Age ranges and life stages
- Professional backgrounds/SUBSPECIALTIES
- Technical sophistication levels
- Decision-making authority
- Geographic considerations (if applicable)
- Risk profiles and coverage needs
${retryInstructions}

## Required JSON Output Format

You MUST return a valid JSON array with exactly ${count} personas. Do not include any text before or after the JSON. Do not use markdown code fences. Start your response with [ and end with ].

Each persona in the array must have this exact structure:
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
      "incomeLevel": "Income bracket (optional, can be null)"
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

CRITICAL: Return ONLY the JSON array starting with [ and ending with ]. No other text.`;
  }

  /**
   * Validate and enrich a persona with defaults
   */
  private validateAndEnrichPersona(raw: Partial<Persona>, index: number): Persona {
    const id = generateSimpleId();

    // Helper to ensure array values
    const ensureArray = (val: unknown, defaults: string[]): string[] => {
      if (Array.isArray(val) && val.length > 0) {
        return val.map(v => String(v));
      }
      return defaults;
    };

    // Validate journey stage
    const validJourneyStages = ['awareness', 'consideration', 'decision', 'retention'] as const;
    const journeyStage = raw.journeyStage && validJourneyStages.includes(raw.journeyStage as typeof validJourneyStages[number])
      ? raw.journeyStage
      : 'consideration';

    // Log what we're processing for debugging
    logger.debug(`Processing persona ${index + 1}: ${raw.name || 'unnamed'}`);

    return {
      id,
      name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim() : `Persona ${index + 1}`,
      title: (typeof raw.title === 'string' && raw.title.trim()) ? raw.title.trim() : 'User Persona',
      bio: (typeof raw.bio === 'string' && raw.bio.trim()) ? raw.bio.trim() : 'A typical user of the website.',
      demographics: {
        ageRange: raw.demographics?.ageRange || '25-54',
        occupation: raw.demographics?.occupation || 'Professional',
        location: raw.demographics?.location || 'United States',
        educationLevel: raw.demographics?.educationLevel || 'Bachelor\'s degree',
        incomeLevel: raw.demographics?.incomeLevel || undefined,
      },
      behavior: {
        onlineHabits: ensureArray(raw.behavior?.onlineHabits, ['Uses search engines', 'Reads reviews', 'Compares options online']),
        preferredChannels: ensureArray(raw.behavior?.preferredChannels, ['Email', 'Website', 'Social media']),
        decisionMakingStyle: raw.behavior?.decisionMakingStyle || 'Research-driven',
        informationSources: ensureArray(raw.behavior?.informationSources, ['Google', 'Industry publications', 'Peer recommendations']),
      },
      painPoints: {
        challenges: ensureArray(raw.painPoints?.challenges, ['Finding reliable information', 'Comparing options']),
        frustrations: ensureArray(raw.painPoints?.frustrations, ['Unclear pricing', 'Lack of transparency']),
        unmetNeeds: ensureArray(raw.painPoints?.unmetNeeds, ['Better customer support', 'More detailed information']),
      },
      goals: {
        primaryGoals: ensureArray(raw.goals?.primaryGoals, ['Solve their problem', 'Make an informed decision']),
        secondaryGoals: ensureArray(raw.goals?.secondaryGoals, ['Save time', 'Stay within budget']),
        motivations: ensureArray(raw.goals?.motivations, ['Efficiency', 'Quality', 'Peace of mind']),
      },
      typicalQuestions: ensureArray(raw.typicalQuestions, ['How does this work?', 'What are the benefits?', 'How much does it cost?']),
      preferredContentFormat: ensureArray(raw.preferredContentFormat, ['Articles', 'Videos', 'FAQs']),
      journeyStage,
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
