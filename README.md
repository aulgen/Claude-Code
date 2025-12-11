# FAQ Content Generator

A multi-agent AI system for generating comprehensive FAQ content based on website analysis, user personas, and fact-checking.

## Features

- **URL Research Agent**: Analyzes websites to extract content, topics, and "People Also Ask" style questions
- **Persona Generator Agent**: Creates 5 detailed user personas based on target audience analysis
- **FAQ Content Generator Agent**: Generates categorized FAQ content with internal linking
- **Fact Checker Agent**: Verifies generated content and provides recommendations
- **Google Docs Integration**: Automatically saves all outputs as Google Docs

## Prerequisites

- Node.js 18+
- Anthropic API key
- (Optional) Google Cloud credentials for Google Docs integration

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd faq-content-generator

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Configure your API keys in .env
```

## Configuration

Edit `.env` file with your credentials:

```env
# Required
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Optional - for Google Docs integration
GOOGLE_CREDENTIALS_PATH=./credentials.json
GOOGLE_DRIVE_FOLDER_ID=your_folder_id

# Optional settings
CLAUDE_MODEL=claude-sonnet-4-20250514
OUTPUT_DIR=./output
LOG_LEVEL=info
```

### Google Docs Setup (Optional)

1. Create a Google Cloud project
2. Enable Google Docs API and Google Drive API
3. Create a service account and download the credentials JSON
4. Save as `credentials.json` in the project root
5. Share your Google Drive folder with the service account email

## Usage

### Interactive Mode

```bash
npm run dev
```

Follow the prompts to enter your URL and configuration options.

### Command Line

```bash
# Basic usage
npm run dev -- generate https://example.com

# With options
npm run dev -- generate https://example.com -p 5 -f 10

# Skip fact-checking
npm run dev -- generate https://example.com --skip-fact-check

# Skip Google Docs
npm run dev -- generate https://example.com --no-google-docs
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --personas <number>` | Number of personas to generate | 5 |
| `-f, --faqs <number>` | Max FAQs per category | 5 |
| `-o, --output <dir>` | Output directory | ./output |
| `--no-google-docs` | Skip Google Docs creation | false |
| `--skip-fact-check` | Skip fact-checking step | false |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Orchestrator                              │
│  Coordinates all agents and manages the generation pipeline      │
└─────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  URL Research │     │   Persona     │     │ FAQ Generator │
│    Agent      │────▶│  Generator    │────▶│    Agent      │
│               │     │    Agent      │     │               │
└───────────────┘     └───────────────┘     └───────────────┘
                                                    │
                                                    ▼
                                           ┌───────────────┐
                                           │  Fact Checker │
                                           │     Agent     │
                                           └───────────────┘
                                                    │
                                                    ▼
                                           ┌───────────────┐
                                           │ Google Docs   │
                                           │   Service     │
                                           └───────────────┘
```

## Output Structure

```
output/
└── Website_Name/
    ├── personas/
    │   ├── Persona_1.md
    │   ├── Persona_2.md
    │   ├── Persona_3.md
    │   ├── Persona_4.md
    │   └── Persona_5.md
    ├── faq-content.md
    ├── faq-content.json
    ├── fact-check-report.md
    └── fact-check-report.json
```

## Agent Details

### URL Research Agent

- Scrapes website content using Cheerio
- Extracts headings, paragraphs, and metadata
- Analyzes target audience and industry context
- Generates "People Also Ask" questions with search intent classification

### Persona Generator Agent

- Creates detailed user personas with:
  - Demographics (age, occupation, location, education)
  - Online behavior and preferences
  - Pain points and challenges
  - Goals and motivations
  - Typical questions they would ask
  - Journey stage (awareness, consideration, decision, retention)

### FAQ Content Generator Agent

- Determines FAQ categories based on website and personas
- Generates comprehensive Q&A pairs (150-300 words each)
- Scans source URL for internal links
- Enriches FAQ answers with relevant internal links
- Classifies content by priority and type

### Fact Checker Agent

- Extracts factual claims from FAQ answers
- Verifies claims against source website content
- Provides verification status:
  - Verified
  - Partially Verified
  - Unverified
  - False
  - Outdated
- Generates recommendations (keep, amend, remove, needs review)
- Creates detailed fact-check reports

## Programmatic Usage

```typescript
import { createFAQOrchestrator } from 'faq-content-generator';

const orchestrator = createFAQOrchestrator();

const result = await orchestrator.execute({
  url: 'https://example.com',
  sampleOutputs: ['Optional sample content'],
  options: {
    numberOfPersonas: 5,
    maxFAQsPerCategory: 5,
    saveToGoogleDocs: true,
    skipFactCheck: false,
  },
});

console.log(result.personas);
console.log(result.faqContent);
console.log(result.factCheckReport);
```

## Development

```bash
# Run in development mode
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Lint code
npm run lint
```

## License

MIT

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a PR.
