/**
 * AI Client - Single OpenRouter Integration
 * 
 * Two focused tasks:
 * 1. Verify if a site is actually WordPress
 * 2. Check if content is relevant to domain/keyword + provide summary
 */
require("dotenv").config();

// Valid free models on OpenRouter (as of Feb 2026)
const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

class AIClient {
  constructor() {
    this.client = null;
    this.stats = {
      totalRequests: 0,
      totalTokens: 0,
      errors: 0,
      lastRequest: null,
    };
  }

  /**
   * Initialize OpenAI client (lazy loading)
   */
  async getClient() {
    if (!this.client) {
      const { OpenAI } = await import("openai");
      this.client = new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        defaultHeaders: {
          "HTTP-Referer": "http://localhost:8080",
          "X-Title": "WordPress Lead Generator",
        },
      });
    }
    return this.client;
  }

  /**
   * Check if API key is configured
   */
  isConfigured() {
    return !!process.env.OPENROUTER_API_KEY;
  }

  /**
   * Chat completion with JSON response
   */
  async chatJSON(systemPrompt, userMessage, options = {}) {
    const client = await this.getClient();
    const startTime = Date.now();

    try {
      const response = await client.chat.completions.create({
        model: options.model || MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
        temperature: options.temperature || 0.1,
        max_tokens: options.maxTokens || 1000,
      });

      this.stats.totalRequests++;
      this.stats.totalTokens += response.usage?.total_tokens || 0;
      this.stats.lastRequest = new Date().toISOString();

      const content = response.choices[0].message.content;

      // Parse JSON response
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        // Try extracting JSON from markdown code block
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1].trim());
        } else {
          throw new Error(`Failed to parse JSON: ${content.substring(0, 200)}...`);
        }
      }

      return {
        content: parsed,
        usage: response.usage,
        responseTime: Date.now() - startTime,
        model: MODEL,
      };
    } catch (error) {
      this.stats.errors++;
      throw error;
    }
  }

  /**
   * TASK 1: Verify WordPress Detection
   * 
   * Checks if a site labeled as WordPress is actually WordPress.
   * Looks for WordPress signatures in the text content.
   * 
   * @param {string} textContent - Scraped text content from the site
   * @returns {Promise<{isWordPress: boolean, confidence: string}>}
   */
  async verifyWordPress(textContent) {
    const systemPrompt = `You are a WordPress detection expert. Analyze the provided website text content and determine if it's genuinely a WordPress site.

Look for indicators like:
- References to WordPress, WP, plugins (Yoast, WooCommerce, Elementor, etc.)
- WordPress-specific terms (wp-content, wp-admin, themes, plugins)
- Common WordPress plugin mentions
- WordPress admin or dashboard references

Return JSON:
{
  "isWordPress": true/false,
  "confidence": "high" | "medium" | "low",
  "indicators": ["list", "of", "indicators", "found"]
}`;

    const userMessage = `Analyze this website content and verify if it's a WordPress site:

${textContent.substring(0, 4000)}`;

    const result = await this.chatJSON(systemPrompt, userMessage);
    return result.content;
  }

  /**
   * TASK 2: Check Content Relevance + Generate Summary
   * 
   * Verifies if the site's actual content matches the search keyword intent.
   * Example: A URL like "ajio-coupons" should have coupon content, not cashback.
   * 
   * @param {string} searchKeyword - The keyword used to find this site
   * @param {string} siteUrl - The URL of the site
   * @param {string} textContent - Scraped text content
   * @returns {Promise<{isRelevant: boolean, actualCategory: string, summary: string, mismatchReason: string|null}>}
   */
  async checkContentRelevance(searchKeyword, siteUrl, textContent) {
    const systemPrompt = `You are a content relevance analyzer for lead generation. Your job is to verify if a website's ACTUAL content matches the search keyword intent.

IMPORTANT: Look at what the site ACTUALLY offers, not what the URL suggests.

Examples of MISMATCHES:
- Keyword "coupons" but site offers "cashback" or "discounts" → NOT RELEVANT
- Keyword "web design agency" but site is a blog about design → NOT RELEVANT  
- Keyword "restaurant" but site is a food delivery app → NOT RELEVANT

Examples of MATCHES:
- Keyword "coupons" and site provides actual coupon codes → RELEVANT
- Keyword "wordpress agency" and site offers WordPress services → RELEVANT

PREDEFINED CATEGORIES (you MUST pick exactly one):
"Digital Marketing", "E-commerce", "Web Development", "Agency", "Blog", "Education", "Technology", "SaaS", "Finance", "Healthcare", "Real Estate", "News & Media", "Legal Services", "Consulting", "Non-profit", "Entertainment", "Travel & Hospitality", "Automotive", "Fashion & Beauty", "Food & Restaurant", "Manufacturing", "Coupons & Deals", "Cashback & Rewards", "Photography", "Sports & Fitness", "Other"

Return JSON:
{
  "isRelevant": true/false,
  "actualCategory": "One of the predefined categories above that best fits the site",
  "summary": "2-3 sentence description of what the site ACTUALLY offers/does",
  "mismatchReason": "If not relevant, explain why (e.g., 'URL suggests coupons but site primarily offers cashback rewards')" or null if relevant
}`;

    const userMessage = `SEARCH KEYWORD: "${searchKeyword}"
SITE URL: ${siteUrl}

WEBSITE CONTENT:
${textContent.substring(0, 4000)}

Analyze if the actual content matches the search keyword intent.`;

    const result = await this.chatJSON(systemPrompt, userMessage);
    return result.content;
  }

  /**
   * COMBINED: Full AI Analysis for a WordPress site
   * 
   * Performs both tasks:
   * 1. Verify it's actually WordPress
   * 2. Check content relevance + generate summary
   * 
   * @param {string} searchKeyword - The keyword used to find this site
   * @param {string} siteUrl - The URL of the site  
   * @param {string} textContent - Scraped text content
   * @returns {Promise<Object>} Complete analysis result
   */
  async analyzeSite(searchKeyword, siteUrl, textContent) {
    const systemPrompt = `You are an AI analyst for a lead generation system. Perform TWO analyses on this website:

**TASK 1: WordPress Verification**
Determine if this is genuinely a WordPress website by looking for:
- WordPress-specific references (wp-content, wp-admin, WordPress, WP)
- Common WordPress plugins (Yoast, WooCommerce, Elementor, Contact Form 7)
- WordPress themes or builder mentions

**TASK 2: Content Relevance Check**
Verify if the site's ACTUAL content matches the search keyword intent.
- Look at what the site REALLY offers, not what the URL suggests
- A "coupon" URL that offers cashback is NOT relevant to coupon searches
- Be strict: the business model must match the keyword intent

PREDEFINED CATEGORIES (you MUST pick exactly one):
"Digital Marketing", "E-commerce", "Web Development", "Agency", "Blog", "Education", "Technology", "SaaS", "Finance", "Healthcare", "Real Estate", "News & Media", "Legal Services", "Consulting", "Non-profit", "Entertainment", "Travel & Hospitality", "Automotive", "Fashion & Beauty", "Food & Restaurant", "Manufacturing", "Coupons & Deals", "Cashback & Rewards", "Photography", "Sports & Fitness", "Other"

Return JSON:
{
  "isWordPress": true/false,
  "wpConfidence": "high" | "medium" | "low",
  "wpIndicators": ["indicators", "found"],
  
  "isRelevant": true/false,
  "actualCategory": "One of the predefined categories above that best fits the site",
  "contentSummary": "2-3 sentence description of what the site does",
  "mismatchReason": "Why not relevant (null if relevant)"
}`;

    const userMessage = `SEARCH KEYWORD: "${searchKeyword}"
SITE URL: ${siteUrl}

WEBSITE CONTENT:
${textContent.substring(0, 5000)}`;

    const result = await this.chatJSON(systemPrompt, userMessage);
    
    return {
      ...result.content,
      responseTime: result.responseTime,
      tokensUsed: result.usage?.total_tokens || 0,
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

// Export singleton
module.exports = new AIClient();
