# AI Consolidation Plan: Single OpenRouter Integration with Agentic Capabilities

## Executive Summary

This plan consolidates the current multi-provider AI system into a **single OpenRouter-based architecture** with **agentic capabilities** (tool/function calling) for performing automated actions within the lead generation workflow.

---

## Current State Analysis

### Current Architecture Issues

1. **Missing ai-providers/ directory** - The folder was deleted but imports remain in `ai-manager.js`
2. **Dead code** - Imports for 10 providers that no longer exist
3. **Over-engineered** - Complex fallback/circuit-breaker logic for single provider
4. **Classification-only AI** - Current AI only classifies websites, doesn't perform actions

### Current AI Usage

| Component | Current AI Use | Status |
|-----------|---------------|--------|
| `ai-processor.js` | Website classification | Working |
| `ai-manager.js` | Provider orchestration | Broken (missing providers) |
| Email system | None | Manual only |
| LinkedIn scraper | None | Rule-based only |

---

## Target Architecture

### Single OpenRouter Integration

```
┌────────────────────────────────────────────────────────────────┐
│                    OpenRouter API                               │
│   (Single API Key → Access to 100+ models)                     │
│                                                                  │
│   Free Models:        │   Paid Models (when needed):            │
│   • google/gemini-2.0-flash-lite:free                          │
│   • meta-llama/llama-3.3-70b:free                              │
│   • qwen/qwen-2.5-72b:free                                     │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                    ai-client.js (NEW)                          │
│   Single OpenRouter client with:                               │
│   • JSON mode for structured output                            │
│   • Function/Tool calling for actions                          │
│   • Model selection helper                                      │
│   • Rate limiting & retry logic                                 │
└────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌─────────────┐   ┌───────────────┐   ┌──────────────┐
   │ Classification│   │ Action Agent  │   │ Email Agent  │
   │ (Existing)    │   │ (NEW)         │   │ (NEW)        │
   └─────────────┘   └───────────────┘   └──────────────┘
```

---

## Implementation Plan

### Phase 1: Clean Up & Simplify (Day 1)

#### 1.1 Remove Dead Code

**Delete imports and refactor `ai-manager.js`:**

```javascript
// BEFORE (broken)
const OpenRouterProvider = require("./ai-providers/openrouter-provider");
const OpenAIProvider = require("./ai-providers/openai-provider");
// ... 8 more imports

// AFTER (clean)
require("dotenv").config();
const OpenAI = require("openai");

const openrouter = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "http://localhost:8080",
    "X-Title": "WordPress Lead Generator",
  },
});
```

#### 1.2 Create Simplified AI Client

Create `ai-client.js`:

```javascript
/**
 * Unified AI Client - OpenRouter Only
 * Supports: Chat completion, JSON output, Function calling
 */
require("dotenv").config();
const OpenAI = require("openai");

// Free models ranked by capability
const MODELS = {
  fast: "google/gemini-2.0-flash-lite-preview-02-05:free",
  balanced: "meta-llama/llama-3.3-70b-instruct:free",
  advanced: "qwen/qwen-2.5-72b-instruct:free",
};

class AIClient {
  constructor() {
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    this.defaultModel = MODELS.fast;
    this.stats = { requests: 0, tokens: 0, errors: 0 };
  }

  /**
   * Simple chat completion
   */
  async chat(systemPrompt, userMessage, options = {}) {
    const { model = this.defaultModel, temperature = 0.1 } = options;
    
    const response = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature,
    });
    
    this.stats.requests++;
    this.stats.tokens += response.usage?.total_tokens || 0;
    
    return response.choices[0].message.content;
  }

  /**
   * Structured JSON output
   */
  async chatJSON(systemPrompt, userMessage, options = {}) {
    const response = await this.client.chat.completions.create({
      model: options.model || this.defaultModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: options.temperature || 0.1,
    });
    
    return JSON.parse(response.choices[0].message.content);
  }

  /**
   * Function/Tool calling for actions
   */
  async chatWithTools(systemPrompt, userMessage, tools, options = {}) {
    const response = await this.client.chat.completions.create({
      model: options.model || MODELS.balanced, // Use more capable model for tool use
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      tools,
      tool_choice: options.toolChoice || "auto",
    });
    
    return response.choices[0].message;
  }
}

module.exports = new AIClient();
```

---

### Phase 2: Agentic Capabilities (Day 2-3)

#### 2.1 Define Action Tools

Create `ai-tools.js` with available actions:

```javascript
/**
 * AI Tools - Actions the AI can perform
 */

const tools = [
  // Database Actions
  {
    type: "function",
    function: {
      name: "search_leads",
      description: "Search the database for leads matching criteria",
      parameters: {
        type: "object",
        properties: {
          classification: { type: "string", description: "Business type filter" },
          minScore: { type: "number", description: "Minimum relevance score (0-100)" },
          hasEmail: { type: "boolean", description: "Only leads with email" },
          limit: { type: "number", description: "Max results to return" },
        },
      },
    },
  },
  
  // Scraping Actions
  {
    type: "function",
    function: {
      name: "run_scraper",
      description: "Run the WordPress detector for a keyword",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search keyword" },
          maxSites: { type: "number", description: "Max sites to scrape" },
        },
        required: ["keyword"],
      },
    },
  },
  
  // Email Actions
  {
    type: "function",
    function: {
      name: "queue_email_campaign",
      description: "Create and queue an email campaign",
      parameters: {
        type: "object",
        properties: {
          templateId: { type: "number", description: "Email template ID" },
          leadIds: { type: "array", items: { type: "number" } },
          scheduledTime: { type: "string", description: "ISO datetime to send" },
        },
        required: ["templateId", "leadIds"],
      },
    },
  },
  
  // Analysis Actions
  {
    type: "function",
    function: {
      name: "analyze_website",
      description: "Get detailed AI analysis of a specific website",
      parameters: {
        type: "object",
        properties: {
          siteId: { type: "number", description: "Site ID from database" },
          url: { type: "string", description: "Website URL to analyze" },
        },
      },
    },
  },
  
  // LinkedIn Actions  
  {
    type: "function",
    function: {
      name: "scrape_executives",
      description: "Scrape LinkedIn executives for a company",
      parameters: {
        type: "object",
        properties: {
          linkedinUrl: { type: "string", description: "LinkedIn company URL" },
          siteId: { type: "number", description: "Associated site ID" },
        },
        required: ["linkedinUrl"],
      },
    },
  },
];

module.exports = tools;
```

#### 2.2 Create Action Executor

Create `ai-executor.js`:

```javascript
/**
 * AI Action Executor
 * Executes tool calls from the AI
 */
const db = require("./database");
const aiClient = require("./ai-client");
const tools = require("./ai-tools");

class ActionExecutor {
  constructor() {
    this.handlers = {
      search_leads: this.searchLeads.bind(this),
      run_scraper: this.runScraper.bind(this),
      queue_email_campaign: this.queueEmailCampaign.bind(this),
      analyze_website: this.analyzeWebsite.bind(this),
      scrape_executives: this.scrapeExecutives.bind(this),
    };
  }

  /**
   * Process an AI request that may include tool calls
   */
  async process(userRequest) {
    const systemPrompt = `You are an AI assistant for a WordPress lead generation system.
You have access to tools to search leads, run scrapers, queue emails, and analyze websites.
Use the appropriate tools to fulfill the user's request.
Always explain what you're doing before and after using tools.`;

    const response = await aiClient.chatWithTools(
      systemPrompt,
      userRequest,
      tools
    );

    // Check if AI wants to use tools
    if (response.tool_calls) {
      const results = [];
      for (const toolCall of response.tool_calls) {
        const handler = this.handlers[toolCall.function.name];
        if (handler) {
          const args = JSON.parse(toolCall.function.arguments);
          const result = await handler(args);
          results.push({
            tool: toolCall.function.name,
            result,
          });
        }
      }
      return { type: "action", results, message: response.content };
    }

    return { type: "response", message: response.content };
  }

  // Tool Implementations
  async searchLeads(params) {
    const { classification, minScore, hasEmail, limit = 50 } = params;
    // Implementation using db functions
    return db.searchSites({ classification, minScore, hasEmail, limit });
  }

  async runScraper(params) {
    // Trigger scraper via existing infrastructure
    const { keyword, maxSites = 20 } = params;
    // Add keyword and mark for scraping
    return { status: "queued", keyword, maxSites };
  }

  async queueEmailCampaign(params) {
    const { templateId, leadIds, scheduledTime } = params;
    // Queue emails for the leads
    return { status: "queued", count: leadIds.length };
  }

  async analyzeWebsite(params) {
    const { siteId, url } = params;
    // Get or perform analysis
    return db.getSiteById(siteId);
  }

  async scrapeExecutives(params) {
    // Trigger LinkedIn scraper
    return { status: "queued", linkedinUrl: params.linkedinUrl };
  }
}

module.exports = new ActionExecutor();
```

---

### Phase 3: Integration & API (Day 4)

#### 3.1 Add API Endpoints

Add to `server.js`:

```javascript
const aiExecutor = require("./ai-executor");

// AI Chat endpoint (agentic)
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, error: "Message required" });
    }
    
    const result = await aiExecutor.process(message);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error(`❌ AI Chat error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI Stats endpoint
app.get("/api/ai/stats", (req, res) => {
  const aiClient = require("./ai-client");
  res.json({ success: true, data: aiClient.stats });
});
```

#### 3.2 Admin Panel Integration

Add AI chat interface to `public/index.html`:

```html
<!-- AI Assistant Tab -->
<div id="ai-assistant" class="tab-content">
  <div class="chat-container">
    <div id="chat-messages"></div>
    <div class="chat-input">
      <input type="text" id="ai-input" placeholder="Ask AI to search leads, run scrapers, etc...">
      <button onclick="sendAIMessage()">Send</button>
    </div>
  </div>
</div>
```

---

### Phase 4: Advanced AI Features (Day 5+)

#### 4.1 Email Content Generation

AI-powered email personalization:

```javascript
async function generatePersonalizedEmail(lead, template) {
  const prompt = `Generate a personalized email for:
Company: ${lead.valueProposition}
Industry: ${lead.classification}
Template style: ${template.name}

Make it professional, non-spammy, and relevant to their business.`;

  return await aiClient.chat(EMAIL_SYSTEM_PROMPT, prompt);
}
```

#### 4.2 Lead Scoring Enhancement

AI-powered lead scoring beyond rule-based:

```javascript
async function enhancedLeadScore(site) {
  const prompt = `Analyze this lead and provide a 0-100 score:
Website: ${site.url}
Classification: ${site.classification}
Value Proposition: ${site.valueProposition}
Has Email: ${site.emails?.length > 0}
Has LinkedIn: ${site.linkedin_urls?.length > 0}

Consider: decision-maker accessibility, budget indicators, timing signals.`;

  return await aiClient.chatJSON(SCORING_PROMPT, prompt);
}
```

#### 4.3 Conversational Memory

For multi-turn conversations:

```javascript
class ConversationManager {
  constructor() {
    this.conversations = new Map();
  }

  async chat(sessionId, message) {
    const history = this.conversations.get(sessionId) || [];
    history.push({ role: "user", content: message });
    
    const response = await aiClient.chatWithHistory(history);
    history.push({ role: "assistant", content: response });
    
    this.conversations.set(sessionId, history.slice(-20)); // Keep last 10 turns
    return response;
  }
}
```

---

## File Changes Summary

### Files to Delete

- `ai-providers/` directory (already deleted, just clean up imports)

### Files to Create

| File | Purpose |
|------|---------|
| `ai-client.js` | Unified OpenRouter client |
| `ai-tools.js` | Tool definitions for actions |
| `ai-executor.js` | Executes AI tool calls |

### Files to Modify

| File | Changes |
|------|---------|
| `ai-manager.js` | Remove dead imports, simplify to use ai-client |
| `ai-processor.js` | Update to use ai-client instead of ai-manager |
| `server.js` | Add `/api/ai/chat` and `/api/ai/stats` routes |
| `public/index.html` | Add AI Assistant tab |

---

## Configuration

### .env File

```env
# Required - Single API Key for all AI
OPENROUTER_API_KEY=sk-or-v1-your-key-here

# Optional - Override default model
OPENROUTER_MODEL=google/gemini-2.0-flash-lite-preview-02-05:free
```

### Recommended Free Models

| Use Case | Model | Why |
|----------|-------|-----|
| **Fast classification** | `google/gemini-2.0-flash-lite:free` | Fastest, good for batch |
| **Tool calling** | `meta-llama/llama-3.3-70b:free` | Better reasoning |
| **Complex analysis** | `qwen/qwen-2.5-72b:free` | Most capable free |

---

## Benefits

1. **Simplicity** - One API key, one client, no provider juggling
2. **Model Flexibility** - Switch models via config, not code
3. **Agentic Power** - AI can execute actions, not just analyze
4. **Cost Efficiency** - Free tier covers most use cases
5. **Maintainability** - ~200 lines replaces ~1000 lines
6. **Future Ready** - Easy to add new tools/actions

---

## Migration Checklist

- [ ] Create `ai-client.js` with OpenRouter integration
- [ ] Create `ai-tools.js` with action definitions
- [ ] Create `ai-executor.js` for tool execution
- [ ] Update `ai-manager.js` to use new client (or remove)
- [ ] Update `ai-processor.js` to use new client
- [ ] Add API routes to `server.js`
- [ ] Add AI chat UI to admin panel
- [ ] Test all existing functionality
- [ ] Test new agentic capabilities
- [ ] Update documentation

---

## Timeline

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Phase 1 | 1 day | Clean code, working ai-client.js |
| Phase 2 | 2 days | Tool definitions, executor |
| Phase 3 | 1 day | API routes, basic UI |
| Phase 4 | 2+ days | Advanced features |

**Total: 6+ days for full implementation**

---

## Next Steps

Ready to start implementation? Reply with:
- "Start Phase 1" - Begin cleanup and ai-client.js creation
- "Show me the code" - Get complete implementation files
- "Questions" - Discuss any part of the plan
