/**
 * Core types and interfaces for the FAQ Content Generator system
 */

// ============================================
// Agent Types
// ============================================

export interface AgentConfig {
  name: string;
  description: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AgentResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface BaseAgent<TInput, TOutput> {
  config: AgentConfig;
  execute(input: TInput): Promise<AgentResponse<TOutput>>;
}

// ============================================
// URL Research Types
// ============================================

export interface WebsiteAnalysis {
  url: string;
  title: string;
  description: string;
  mainTopics: string[];
  targetAudience: string[];
  industryContext: string;
  keyProducts?: string[];
  keyServices?: string[];
  uniqueSellingPoints: string[];
  brandVoice: string;
  contentThemes: string[];
}

export interface PeopleAlsoAskQuestion {
  question: string;
  relatedTopics: string[];
  searchIntent: 'informational' | 'navigational' | 'transactional' | 'commercial';
  estimatedRelevance: number; // 0-1
}

export interface URLResearchResult {
  websiteAnalysis: WebsiteAnalysis;
  peopleAlsoAsk: PeopleAlsoAskQuestion[];
  competitorInsights?: string[];
  rawContent: string;
  scrapedAt: Date;
}

// ============================================
// Persona Types
// ============================================

export interface PersonaDemographics {
  ageRange: string;
  occupation: string;
  location: string;
  educationLevel: string;
  incomeLevel?: string;
}

export interface PersonaBehavior {
  onlineHabits: string[];
  preferredChannels: string[];
  decisionMakingStyle: string;
  informationSources: string[];
}

export interface PersonaPainPoints {
  challenges: string[];
  frustrations: string[];
  unmetNeeds: string[];
}

export interface PersonaGoals {
  primaryGoals: string[];
  secondaryGoals: string[];
  motivations: string[];
}

export interface Persona {
  id: string;
  name: string;
  title: string;
  bio: string;
  avatar?: string;
  demographics: PersonaDemographics;
  behavior: PersonaBehavior;
  painPoints: PersonaPainPoints;
  goals: PersonaGoals;
  typicalQuestions: string[];
  preferredContentFormat: string[];
  journeyStage: 'awareness' | 'consideration' | 'decision' | 'retention';
  createdAt: Date;
}

export interface PersonaGeneratorInput {
  websiteAnalysis: WebsiteAnalysis;
  peopleAlsoAsk: PeopleAlsoAskQuestion[];
  sampleOutputs?: string[];
  numberOfPersonas?: number;
}

export interface PersonaGeneratorOutput {
  personas: Persona[];
  rationale: string;
}

// ============================================
// FAQ Content Types
// ============================================

export interface FAQItem {
  id: string;
  question: string;
  answer: string;
  category: string;
  targetPersonas: string[]; // Persona IDs
  keywords: string[];
  priority: 'high' | 'medium' | 'low';
  contentType: 'factual' | 'procedural' | 'conceptual' | 'troubleshooting';
}

export interface FAQCategory {
  id: string;
  name: string;
  description: string;
  faqs: FAQItem[];
}

export interface FAQContentResult {
  categories: FAQCategory[];
  totalFAQs: number;
  coverageByPersona: Record<string, number>;
  generatedAt: Date;
}

export interface FAQGeneratorInput {
  websiteAnalysis: WebsiteAnalysis;
  personas: Persona[];
  peopleAlsoAsk: PeopleAlsoAskQuestion[];
  existingFAQs?: FAQItem[];
  maxFAQsPerCategory?: number;
}

// ============================================
// Fact Checking Types
// ============================================

export type VerificationStatus = 'verified' | 'partially_verified' | 'unverified' | 'false' | 'outdated';

export interface VerificationSource {
  url: string;
  title: string;
  snippet: string;
  credibilityScore: number; // 0-1
  accessedAt: Date;
}

export interface ClaimVerification {
  claim: string;
  status: VerificationStatus;
  confidence: number; // 0-1
  sources: VerificationSource[];
  explanation: string;
}

export interface FactCheckResult {
  faqId: string;
  question: string;
  originalAnswer: string;
  claims: ClaimVerification[];
  overallVerificationScore: number; // 0-1
  recommendation: FactCheckRecommendation;
}

export type RecommendationAction = 'keep' | 'amend' | 'remove' | 'needs_review';

export interface FactCheckRecommendation {
  action: RecommendationAction;
  suggestedChanges?: string;
  reasoning: string;
  priority: 'critical' | 'important' | 'minor';
}

export interface FactCheckReport {
  totalFAQsChecked: number;
  verifiedCount: number;
  partiallyVerifiedCount: number;
  unverifiedCount: number;
  falseCount: number;
  outdatedCount: number;
  results: FactCheckResult[];
  summary: string;
  generatedAt: Date;
}

export interface FactCheckerInput {
  faqs: FAQItem[];
  websiteUrl: string;
  additionalSources?: string[];
}

// ============================================
// Google Docs Types
// ============================================

export interface GoogleDocMetadata {
  documentId: string;
  title: string;
  url: string;
  createdAt: Date;
}

export interface GoogleDocsConfig {
  credentialsPath: string;
  folderId?: string;
}

// ============================================
// Orchestrator Types
// ============================================

export interface OrchestratorInput {
  url: string;
  sampleOutputs?: string[];
  options?: OrchestratorOptions;
}

export interface OrchestratorOptions {
  numberOfPersonas?: number;
  maxFAQsPerCategory?: number;
  skipFactCheck?: boolean;
  saveToGoogleDocs?: boolean;
  outputDir?: string;
}

export interface OrchestratorResult {
  urlResearch: URLResearchResult;
  personas: Persona[];
  faqContent: FAQContentResult;
  factCheckReport?: FactCheckReport;
  googleDocs?: GoogleDocMetadata[];
  executionTime: number;
}

// ============================================
// Utility Types
// ============================================

export interface LogEntry {
  timestamp: Date;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

export interface ProgressCallback {
  (stage: string, progress: number, message: string): void;
}
