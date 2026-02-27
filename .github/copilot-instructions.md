# WordPress Detector & Lead Generation - Copilot Instructions

## Overview

Lead generation automation system that scrapes WordPress sites from Google, extracts contacts (emails, phones, LinkedIn), finds company executives, and sends automated email campaigns. Uses Playwright for browser automation and SQLite for persistence.

## Code Style

- **JavaScript ES6+** with CommonJS (`require`/`module.exports`)
- **Async/await** for all async operations - no callbacks
- **Naming**:
  - `camelCase` for functions/variables: `findContactPage`, `processQueue`
  - `PascalCase` for classes: `AIProcessor`, `AIClient`
  - `SCREAMING_SNAKE_CASE` for constants: `BATCH_SIZE`, `CYCLE_DELAY_MS`

**Exemplary files**: [ai-client.js](../ai-client.js), [ai-processor.js](../ai-processor.js)

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Admin Panel   │────▶│    server.js     │────▶│   database.js   │
│   (public/)     │     │   Express API    │     │    SQLite DB    │
└─────────────────┘     └───────┬──────────┘     └─────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ ai-processor  │    │  email-worker    │    │ linkedin-scraper │
│  (AI Queue)   │    │  (Email Queue)   │    │   (Executives)   │
└───────┬───────┘    └──────────────────┘    └──────────────────┘
        ▼
┌───────────────┐
│  ai-manager   │ ─▶ Provider selection, fallback, circuit breaker
│  (singleton)  │
└───────┬───────┘
        ▼
┌─────────────────────────────────────────┐
│         ai-providers/                   │
│  BaseProvider ◀─ OpenRouterProvider     │
│              ◀─ GroqProvider, etc.      │
└─────────────────────────────────────────┘
```

**Key patterns**:
- **Provider inheritance**: All AI providers extend `BaseProvider` with `async chat(systemPrompt, userMessage, schema)`
- **Singleton workers**: `ai-processor.js`, `ai-manager.js` export singleton instances
- **Background processors**: Class-based with `start()`, `stop()`, `pause()`, `resume()` methods

## API Response Format

```javascript
// Success
res.json({ success: true, data: result });
res.json({ success: true, message: "Action completed" });

// Error
res.status(400).json({ success: false, error: "Error message" });
res.status(500).json({ success: false, error: error.message });
```

## Build and Test

```bash
npm install                    # Install dependencies
npm run admin                  # Start server on port 8080
npx playwright test            # Run Playwright tests
node wordpress-detector.js     # Run detector standalone
```

## Database Conventions

- **Library**: `better-sqlite3` (synchronous)
- **Migrations**: Inline in `initDatabase()` with try-catch for existing columns
- **Transactions**: Use `db.transaction(...)` for batch inserts

```javascript
// Query pattern
const db = new Database(DB_PATH);
const stmt = db.prepare('SELECT * FROM sites WHERE id = ?');
const site = stmt.get(siteId);
```

## AI Provider Pattern

When adding a new AI provider:

1. Create `ai-providers/{name}-provider.js` extending `BaseProvider`
2. Implement `async chat(systemPrompt, userMessage, schema)` method
3. Call `this.recordSuccess()` / `this.recordFailure()` for health tracking
4. Register in `ai-manager.js` providerClasses array

```javascript
class NewProvider extends BaseProvider {
  constructor(config = {}) {
    super({
      name: 'NewProvider',
      model: config.model || 'default-model',
      apiKey: process.env.NEW_PROVIDER_API_KEY,
      priority: config.priority || 5,
      requestsPerMinute: 30,
    });
  }

  async chat(systemPrompt, userMessage, schema) {
    const startTime = Date.now();
    try {
      // API call logic
      this.recordSuccess(Date.now() - startTime, { input: tokens, output: tokens });
      return { provider: this.name, content: parsed, usage: {...} };
    } catch (error) {
      this.recordFailure(error);
      throw error;
    }
  }
}
```

## Error Handling

- Wrap route handlers in try-catch
- Log with emoji prefixes: `✅`, `❌`, `⚠️`, `🤖`, `📊`
- Graceful fallbacks for non-critical errors

```javascript
try {
  const result = await someOperation();
  console.log(`✅ Operation completed`);
  res.json({ success: true, data: result });
} catch (error) {
  console.error(`❌ Operation failed: ${error.message}`);
  res.status(500).json({ success: false, error: error.message });
}
```

## Configuration

- API keys via `.env` file (loaded with `require("dotenv").config()`)
- Required keys: `OPENROUTER_API_KEY` (primary AI)
- Optional: `GROQ_API_KEY`, `ANTHROPIC_API_KEY`, etc.

## Browser Automation (Playwright)

- Persistent Chrome context at `C:\automation_chrome`
- Anti-detection scripts injected via `page.addInitScript`
- Random delays between actions: `Math.random() * (max - min) + min`

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express API, routes, background worker start |
| `ai-manager.js` | AI orchestration, provider selection, fallback |
| `ai-processor.js` | Background AI classification worker |
| `database.js` | SQLite wrapper, schema, queries |
| `wordpress-detector.js` | Core Playwright scraper |
| `linkedin-company-scraper.js` | Executive scraping from LinkedIn |
| `email-queue-worker.js` | Email campaign processing |

## JSON Schema for AI Classification

The AI classifies websites using this schema structure - always maintain compatibility:

```javascript
{
  isLikelyWordPress: boolean,
  isGenuineMatch: boolean,
  classification: string,
  relevanceScore: number (0-100),
  tags: string[],
  primaryLanguage: string,
  valueProposition: string,
  reasoning: string
}
```
