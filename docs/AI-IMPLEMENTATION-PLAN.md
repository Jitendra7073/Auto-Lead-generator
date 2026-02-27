# AI Implementation Plan: Website Classification + Auto Email Templates

## Overview

This plan implements **two focused AI use cases** using a single OpenRouter API key:

| Use Case | Purpose | Priority |
|----------|---------|----------|
| **Website Classification** | Analyze scraped websites to score relevance, detect business type | Core (fix existing) |
| **Auto Email Templates** | Generate personalized email content based on lead data | New feature |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OpenRouter API                                │
│           (Single API key → Access to free models)                   │
│                                                                      │
│   Model: google/gemini-2.0-flash-lite-preview-02-05:free            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        ai-client.js                                  │
│   • chat(systemPrompt, userMessage) → text response                 │
│   • chatJSON(systemPrompt, userMessage) → parsed JSON               │
│   • Retry logic, rate limiting, error handling                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
           ┌───────────────────┴───────────────────┐
           ▼                                       ▼
┌─────────────────────┐               ┌─────────────────────────────┐
│ Website Classifier  │               │   Email Template Generator  │
│  (ai-processor.js)  │               │  (email-ai-generator.js)    │
└─────────────────────┘               └─────────────────────────────┘
           │                                       │
           ▼                                       ▼
┌─────────────────────┐               ┌─────────────────────────────┐
│  Saves to sites:    │               │  Generates for:             │
│  • classification   │               │  • Subject line             │
│  • relevance_score  │               │  • HTML body                │
│  • tags             │               │  • Personalized variables   │
│  • value_proposition│               │  • Follow-up sequences      │
└─────────────────────┘               └─────────────────────────────┘
```

---

## Use Case 1: Website Classification

### Current State
- ✅ `ai-processor.js` exists and works
- ❌ `ai-manager.js` has broken imports (missing ai-providers/)
- ✅ Database schema ready (classification, relevance_score, tags, etc.)

### What It Does
After scraping a website, AI analyzes the text content and returns:

```javascript
{
  isLikelyWordPress: true,        // Verified WordPress?
  isGenuineMatch: true,           // Matches search intent?
  classification: "B2B SaaS",     // Business category
  relevanceScore: 85,             // 0-100 lead quality
  tags: ["saas", "b2b", "software"],
  primaryLanguage: "English",
  valueProposition: "Cloud-based CRM for small businesses",
  reasoning: "High relevance - directly sells B2B software"
}
```

### Implementation Tasks

| Task | File | Action |
|------|------|--------|
| 1. Create ai-client.js | `ai-client.js` (new) | Single OpenRouter client |
| 2. Fix ai-processor.js | `ai-processor.js` | Use ai-client instead of ai-manager |
| 3. Delete ai-manager.js | `ai-manager.js` | Remove (replaced by ai-client) |
| 4. Update server.js | `server.js` | Update AI status endpoints |

### ai-client.js Code

```javascript
/**
 * AI Client - Single OpenRouter Integration
 */
require("dotenv").config();
const OpenAI = require("openai");

const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-lite-preview-02-05:free";

class AIClient {
  constructor() {
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      defaultHeaders: {
        "HTTP-Referer": "http://localhost:8080",
        "X-Title": "WordPress Lead Generator",
      },
    });
    
    this.stats = {
      totalRequests: 0,
      totalTokens: 0,
      errors: 0,
      lastRequest: null,
    };
  }

  /**
   * Check if API key is configured
   */
  isConfigured() {
    return !!process.env.OPENROUTER_API_KEY;
  }

  /**
   * Simple chat completion returning text
   */
  async chat(systemPrompt, userMessage, options = {}) {
    const startTime = Date.now();
    
    try {
      const response = await this.client.chat.completions.create({
        model: options.model || MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: options.temperature || 0.1,
        max_tokens: options.maxTokens || 2000,
      });

      this.stats.totalRequests++;
      this.stats.totalTokens += response.usage?.total_tokens || 0;
      this.stats.lastRequest = new Date().toISOString();

      return {
        content: response.choices[0].message.content,
        usage: response.usage,
        responseTime: Date.now() - startTime,
      };
    } catch (error) {
      this.stats.errors++;
      throw error;
    }
  }

  /**
   * Chat completion with JSON response parsing
   */
  async chatJSON(systemPrompt, userMessage, options = {}) {
    const response = await this.client.chat.completions.create({
      model: options.model || MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      response_format: { type: "json_object" },
      temperature: options.temperature || 0.1,
      max_tokens: options.maxTokens || 2000,
    });

    this.stats.totalRequests++;
    this.stats.totalTokens += response.usage?.total_tokens || 0;
    this.stats.lastRequest = new Date().toISOString();

    const content = response.choices[0].message.content;
    
    // Parse JSON, handling potential markdown code blocks
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      // Try extracting JSON from markdown code block
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1].trim());
      } else {
        throw new Error(`Failed to parse JSON: ${content.substring(0, 100)}...`);
      }
    }

    return {
      content: parsed,
      usage: response.usage,
      responseTime: Date.now() - startTime,
    };
  }

  /**
   * Get client statistics
   */
  getStats() {
    return {
      ...this.stats,
      model: MODEL,
      configured: this.isConfigured(),
    };
  }
}

module.exports = new AIClient();
```

---

## Use Case 2: Auto Email Templates

### Purpose
Generate personalized email content based on:
- Lead's business classification
- Lead's value proposition
- Search keyword used
- Your service offering

### Database Schema (already exists)
```sql
email_templates (
  id, name, subject, html_content, text_content, description, category
)
```

### New Feature: AI-Generated Templates

#### 2.1 API Endpoint: Generate Template

```
POST /api/email/templates/generate
```

**Request:**
```json
{
  "serviceDescription": "We offer WordPress maintenance and security services",
  "targetAudience": "Small business owners with WordPress sites",
  "tone": "professional",        // professional, friendly, casual
  "emailType": "cold_outreach",  // cold_outreach, follow_up, value_offer
  "includeFollowUp": true        // Generate follow-up sequence?
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "template": {
      "name": "WordPress Security Outreach",
      "subject": "Quick question about {{company_name}}'s website security",
      "html_content": "<p>Hi {{first_name}},</p>...",
      "text_content": "Hi {{first_name}},...",
      "variables": ["first_name", "company_name", "website_url"]
    },
    "followUps": [
      {
        "dayDelay": 3,
        "subject": "Following up on website security",
        "html_content": "..."
      },
      {
        "dayDelay": 7,
        "subject": "Last chance: Free security audit",
        "html_content": "..."
      }
    ]
  }
}
```

#### 2.2 API Endpoint: Personalize Email for Lead

```
POST /api/email/personalize
```

**Request:**
```json
{
  "templateId": 5,
  "siteId": 123
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "subject": "Quick question about TechStartup Inc's website security",
    "html_content": "<p>Hi John,</p><p>I noticed your company TechStartup Inc is running WordPress...</p>",
    "personalizationScore": 92
  }
}
```

### Implementation: email-ai-generator.js

```javascript
/**
 * AI Email Generator
 * Generates and personalizes email templates using AI
 */
const aiClient = require("./ai-client");
const db = require("./database");

const EMAIL_SYSTEM_PROMPT = `You are an expert email copywriter specializing in B2B cold outreach.
Your emails are:
- Non-spammy and genuine
- Personalized to the recipient's business
- Clear value proposition in first 2 sentences
- Professional but friendly tone
- Short (under 150 words)
- Include a specific, low-commitment CTA

ALWAYS return valid JSON matching the requested schema.`;

/**
 * Generate a new email template
 */
async function generateTemplate(options) {
  const {
    serviceDescription,
    targetAudience,
    tone = "professional",
    emailType = "cold_outreach",
    includeFollowUp = false,
  } = options;

  const prompt = `Generate a ${emailType.replace("_", " ")} email template.

SERVICE: ${serviceDescription}
TARGET: ${targetAudience}
TONE: ${tone}

Return JSON with this schema:
{
  "name": "Template name",
  "subject": "Email subject with {{company_name}} variable",
  "html_content": "HTML email body with variables like {{first_name}}, {{company_name}}, {{website_url}}",
  "text_content": "Plain text version",
  "variables": ["list", "of", "variables", "used"]
}`;

  const result = await aiClient.chatJSON(EMAIL_SYSTEM_PROMPT, prompt);
  
  const template = result.content;
  
  // Generate follow-ups if requested
  let followUps = [];
  if (includeFollowUp) {
    followUps = await generateFollowUpSequence(template, serviceDescription);
  }

  return { template, followUps };
}

/**
 * Generate follow-up email sequence
 */
async function generateFollowUpSequence(originalTemplate, serviceDescription) {
  const prompt = `Based on this original cold email:
Subject: ${originalTemplate.subject}
Body: ${originalTemplate.text_content}

Generate 2 follow-up emails for a sequence.

Return JSON array:
[
  {
    "dayDelay": 3,
    "subject": "Follow-up subject",
    "html_content": "HTML body",
    "text_content": "Plain text"
  },
  {
    "dayDelay": 7,
    "subject": "Final follow-up subject",
    "html_content": "HTML body",
    "text_content": "Plain text"
  }
]`;

  const result = await aiClient.chatJSON(EMAIL_SYSTEM_PROMPT, prompt);
  return result.content;
}

/**
 * Personalize an email template for a specific lead
 */
async function personalizeForLead(templateId, siteId) {
  // Get template
  const template = db.get("SELECT * FROM email_templates WHERE id = ?", [templateId]);
  if (!template) throw new Error("Template not found");

  // Get site/lead data
  const site = db.get(`
    SELECT s.*, 
           GROUP_CONCAT(DISTINCT CASE WHEN c.type = 'email' THEN c.value END) as emails
    FROM sites s
    LEFT JOIN contacts c ON s.id = c.site_id
    WHERE s.id = ?
    GROUP BY s.id
  `, [siteId]);
  if (!site) throw new Error("Site not found");

  // Get executive if available
  const executive = db.get(`
    SELECT * FROM company_executives 
    WHERE site_id = ? 
    ORDER BY 
      CASE role_category 
        WHEN 'CEO' THEN 1 
        WHEN 'Founder' THEN 2 
        WHEN 'Co-Founder' THEN 3 
        ELSE 4 
      END
    LIMIT 1
  `, [siteId]);

  // Build context for AI
  const leadContext = {
    website_url: site.url,
    company_name: extractCompanyName(site.url, site.value_proposition),
    classification: site.classification,
    value_proposition: site.value_proposition,
    first_name: executive?.name?.split(" ")[0] || "there",
    full_name: executive?.name || "",
    role: executive?.role_category || "",
  };

  const prompt = `Personalize this email template for the lead.

TEMPLATE:
Subject: ${template.subject}
Body: ${template.html_content}

LEAD DATA:
${JSON.stringify(leadContext, null, 2)}

Instructions:
1. Replace all {{variables}} with actual values
2. Add 1-2 sentences specific to their business (${site.classification})
3. Reference their value proposition naturally

Return JSON:
{
  "subject": "Personalized subject",
  "html_content": "Personalized HTML body",
  "text_content": "Personalized plain text",
  "personalizationScore": 0-100
}`;

  const result = await aiClient.chatJSON(EMAIL_SYSTEM_PROMPT, prompt);
  return result.content;
}

/**
 * Extract company name from URL or value proposition
 */
function extractCompanyName(url, valueProposition) {
  try {
    const hostname = new URL(url).hostname;
    // Remove www and TLD
    let name = hostname.replace(/^www\./, "").split(".")[0];
    // Capitalize
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return "your company";
  }
}

module.exports = {
  generateTemplate,
  generateFollowUpSequence,
  personalizeForLead,
};
```

### API Routes (add to email-senders-templates-api.js)

```javascript
const emailAI = require("./email-ai-generator");

// Generate AI template
router.post("/templates/generate", async (req, res) => {
  try {
    const result = await emailAI.generateTemplate(req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error(`❌ Template generation failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Personalize template for lead
router.post("/personalize", async (req, res) => {
  try {
    const { templateId, siteId } = req.body;
    if (!templateId || !siteId) {
      return res.status(400).json({ 
        success: false, 
        error: "templateId and siteId required" 
      });
    }
    
    const result = await emailAI.personalizeForLead(templateId, siteId);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error(`❌ Personalization failed: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk personalize for campaign
router.post("/campaigns/:id/personalize", async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { templateId, siteIds } = req.body;
    
    const results = [];
    for (const siteId of siteIds) {
      try {
        const personalized = await emailAI.personalizeForLead(templateId, siteId);
        results.push({ siteId, success: true, data: personalized });
      } catch (e) {
        results.push({ siteId, success: false, error: e.message });
      }
    }
    
    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

---

## File Changes Summary

### New Files to Create

| File | Purpose |
|------|---------|
| `ai-client.js` | Single OpenRouter client |
| `email-ai-generator.js` | Email template AI generation |

### Files to Modify

| File | Changes |
|------|---------|
| `ai-processor.js` | Replace `require("./ai-manager")` with `require("./ai-client")` |
| `server.js` | Update AI status endpoints to use ai-client |
| `email-senders-templates-api.js` | Add AI template generation routes |

### Files to Delete

| File | Reason |
|------|--------|
| `ai-manager.js` | Replaced by simpler ai-client.js |
| `AI-README.md` | Documents non-existent providers |

---

## Implementation Order

### Phase 1: Foundation (Day 1)
1. ✅ Create `ai-client.js`
2. ✅ Update `ai-processor.js` to use it
3. ✅ Delete `ai-manager.js`
4. ✅ Test website classification still works

### Phase 2: Email AI (Day 2)
1. ✅ Create `email-ai-generator.js`
2. ✅ Add API routes
3. ✅ Test template generation
4. ✅ Test personalization

### Phase 3: UI Integration (Day 3)
1. ✅ Add "Generate with AI" button in email-manager.html
2. ✅ Add personalization preview
3. ✅ Add follow-up sequence builder

---

## Testing Checklist

### Website Classification
- [ ] Scrape a keyword and verify AI processes pending sites
- [ ] Check database has classification, relevance_score, tags
- [ ] Verify AI status endpoint returns stats

### Email Templates
- [ ] Generate template via API
- [ ] Save generated template to database
- [ ] Personalize template for a lead
- [ ] Preview personalized email
- [ ] Send personalized email

---

## Cost Estimate

Using `google/gemini-2.0-flash-lite:free`:
- **Cost**: $0.00 (free tier)
- **Rate limit**: 15 requests/minute
- **Classification**: ~500 tokens/request
- **Email generation**: ~800 tokens/request

For 100 leads/day:
- Classifications: 100 × 500 = 50,000 tokens ✅ Free
- Emails: 100 × 800 = 80,000 tokens ✅ Free

---

## Ready to Implement?

Reply with:
- **"Start Phase 1"** - Create ai-client.js and fix classification
- **"Start Phase 2"** - Create email-ai-generator.js
- **"Do it all"** - Complete implementation
