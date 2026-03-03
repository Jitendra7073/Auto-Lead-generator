const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./database");
const { chromium } = require("playwright");
const { LinkedInCompanyScraper } = require("./linkedin-company-scraper");
const emailRouter = require("./email-senders-templates-api");
const worker = require("./email-queue-worker");
const aiWorker = require("./ai-processor"); // Import new AI classification worker

const app = express();
const PORT = 8080;
const userDataDir = "C:\\automation_chrome";

// Start background workers
aiWorker.start();

// Track executive scraper status
let executiveScraperStatus = { running: false, progress: 0, total: 0 };

// ========== CONTACT EXTRACTION FUNCTIONS ==========

/**
 * Find contact page link
 * @param {Page} page - Playwright page object
 * @param {string} baseUrl - The website URL
 * @returns {string|null} - Contact page URL or null
 */
async function findContactPage(page, baseUrl) {
  try {
    const contactLink = await page.evaluate(() => {
      const contactSelectors = [
        'a[href*="contact"]',
        'a[href*="contact-us"]',
        'a[href*="contactus"]',
        'a[href*="get-in-touch"]',
        'a[href*="about"]',
        'a[href*="team"]',
      ];

      const links = Array.from(document.querySelectorAll("a"));

      // Priority: exact "contact" matches first
      for (const selector of contactSelectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.textContent.toLowerCase().trim();
          const href = el.href;
          if (
            href &&
            (text.includes("contact") || text.includes("get in touch"))
          ) {
            return href;
          }
        }
      }

      // Fallback: any link containing "contact"
      for (const link of links) {
        const href = link.href?.toLowerCase();
        if (href && href.includes("contact")) {
          return link.href;
        }
      }

      return null;
    });

    return contactLink;
  } catch (error) {
    console.error(`Error finding contact page: ${error.message}`);
    return null;
  }
}

/**
 * Extract emails from text content
 */
function extractEmails(content) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = content.match(emailRegex) || [];

  const falsePositives = [
    /example\.com/i,
    /test\.com/i,
    /localhost/i,
    /127\.0\.0\.1/i,
    /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$/i,
    /@.*\.(png|jpg|jpeg|gif|svg|ico)$/i,
    /noreply|no-reply|donotreply/i,
    /privacy|terms|legal|abuse/i,
    /postmaster|webmaster/i,
  ];

  const uniqueEmails = [...new Set(matches)]
    .map((email) => email.toLowerCase())
    .filter((email) => !falsePositives.some((pattern) => pattern.test(email)));

  return uniqueEmails;
}

/**
 * Extract phone numbers from text content
 */
function extractPhones(content) {
  const phoneRegexes = [
    /\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
    /\+?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  ];

  const allMatches = [];
  for (const regex of phoneRegexes) {
    const matches = content.match(regex) || [];
    allMatches.push(...matches);
  }

  const falsePositives = [
    /123[-.\s]?\d{3}[-.\s]?\d{4}/,
    /000[-.\s]?\d{3}[-.\s]?\d{4}/,
    /111[-.\s]?\d{3}[-.\s]?\d{4}/,
    /999[-.\s]?\d{3}[-.\s]?\d{4}/,
    /\d{10}/,
  ];

  const uniquePhones = [...new Set(allMatches)]
    .map((phone) => phone.replace(/[^\d+]/g, "").substring(0, 15))
    .filter(
      (phone) =>
        phone.length >= 10 &&
        phone.length <= 15 &&
        !falsePositives.some((pattern) => pattern.test(phone)),
    );

  return uniquePhones;
}

/**
 * Extract LinkedIn profile URLs from content
 * Matches company pages, showcase pages, and personal profiles
 */
function extractLinkedIn(content) {
  const linkedinRegexes = [
    // LinkedIn company pages
    /https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9-]+/gi,
    // LinkedIn showcase pages
    /https?:\/\/(?:www\.)?linkedin\.com\/showcase\/[a-zA-Z0-9-]+/gi,
    // LinkedIn personal profiles (optional - can be enabled if needed)
    // /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9-]+/gi,
    // LinkedIn school/university pages
    /https?:\/\/(?:www\.)?linkedin\.com\/school\/[a-zA-Z0-9-]+/gi,
  ];

  const allMatches = [];
  for (const regex of linkedinRegexes) {
    const matches = content.match(regex) || [];
    allMatches.push(...matches);
  }

  // Clean and dedupe URLs
  const uniqueLinkedIns = [...new Set(allMatches)]
    .map((url) => url.split("?")[0]) // Remove query parameters
    .filter((url) => {
      // Filter out false positives and generic links
      const falsePositives = [
        /linkedin\.com\/\/$/,
        /linkedin\.com\/company\/$/,
      ];
      return !falsePositives.some((pattern) => pattern.test(url));
    });

  return uniqueLinkedIns;
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Store running scrapers
const runningScrapers = new Map();

// Import Email API router
const emailApiRouter = require("./email-senders-templates-api");

// Mount email API routes
app.use("/api/email", emailApiRouter);

// ============ API ROUTES ============

// =====================================================
// EXCLUDED DOMAINS ENDPOINTS
// =====================================================

// Get all excluded domains
app.get("/api/excluded-domains", (req, res) => {
  try {
    const domains = db.getAllExcludedDomains();
    res.json({ success: true, data: domains });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add excluded domain
app.post("/api/excluded-domains", (req, res) => {
  try {
    const { domain, reason } = req.body;
    if (!domain || domain.trim() === "") {
      return res
        .status(400)
        .json({ success: false, error: "Domain is required" });
    }
    const result = db.addExcludedDomain(domain, reason || "");
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes("UNIQUE")) {
      res.status(400).json({ success: false, error: "Domain already excluded" });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Update excluded domain
app.put("/api/excluded-domains/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { domain, reason } = req.body;
    if (!domain || domain.trim() === "") {
      return res
        .status(400)
        .json({ success: false, error: "Domain is required" });
    }
    const result = db.updateExcludedDomain(parseInt(id), domain, reason || "");
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: "Excluded domain not found" });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes("UNIQUE")) {
      res.status(400).json({ success: false, error: "Domain already excluded" });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Delete excluded domain
app.delete("/api/excluded-domains/:id", (req, res) => {
  try {
    const { id } = req.params;
    const result = db.deleteExcludedDomain(parseInt(id));
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: "Excluded domain not found" });
    }
    res.json({ success: true, data: { deleted: result } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all keywords
app.get("/api/keywords", (req, res) => {
  try {
    const keywords = db.getAllKeywords();
    res.json({ success: true, data: keywords });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add keyword
app.post("/api/keywords", (req, res) => {
  try {
    const { keyword, max_sites } = req.body;
    if (!keyword || keyword.trim() === "") {
      return res
        .status(400)
        .json({ success: false, error: "Keyword is required" });
    }
    // Parse max_sites: 0 means unlimited (10000), negative/invalid defaults to 20
    let limit;
    const parsed = parseInt(max_sites);
    if (parsed === 0 || max_sites === 'unlimited') {
      limit = 10000; // Unlimited mode
    } else if (parsed > 0) {
      limit = parsed;
    } else {
      limit = 20; // Default
    }
    const result = db.addKeyword(keyword, limit);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error.message.includes("UNIQUE")) {
      res.status(400).json({ success: false, error: "Keyword already exists" });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// Update keyword
app.put("/api/keywords/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { keyword } = req.body;
    if (!keyword || keyword.trim() === "") {
      return res
        .status(400)
        .json({ success: false, error: "Keyword is required" });
    }
    const result = db.updateKeyword(parseInt(id), keyword);
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: "Keyword not found" });
    }
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete keyword
app.delete("/api/keywords/:id", (req, res) => {
  try {
    const { id } = req.params;
    const result = db.deleteKeyword(parseInt(id));
    res.json({ success: true, data: { deleted: result } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get statistics
app.get("/api/stats", (req, res) => {
  try {
    const stats = db.getStatistics();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// AI STATUS ENDPOINTS
// =====================================================

const aiClient = require("./ai-client");

// Get AI statistics (formatted for UI)
app.get("/api/ai/stats", (req, res) => {
  try {
    const clientStats = aiClient.getStats();
    const processorStats = aiWorker.getStats();
    
    // Format for UI compatibility
    const stats = {
      availableProviders: clientStats.configured ? 1 : 0,
      totalProviders: 1,
      successRate: clientStats.totalRequests > 0 
        ? Math.round(((clientStats.totalRequests - clientStats.errors) / clientStats.totalRequests) * 100) 
        : 100,
      totalRequests: clientStats.totalRequests,
      totalCost: "0.00", // OpenRouter free tier
      totalTokens: clientStats.totalTokens,
      model: clientStats.model,
      lastRequest: clientStats.lastRequest,
      processor: processorStats,
    };
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get AI providers list
app.get("/api/ai/providers", (req, res) => {
  try {
    const clientStats = aiClient.getStats();
    const providers = [{
      name: "OpenRouter",
      model: clientStats.model,
      status: clientStats.configured ? "healthy" : "down",
      enabled: true,
      healthScore: clientStats.configured ? 100 : 0,
      successCount: clientStats.totalRequests - clientStats.errors,
      failureCount: clientStats.errors,
      averageResponseTime: 2000,
      totalCost: "0.00",
      rateLimitRemaining: 60,
    }];
    res.json({ success: true, data: providers });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get AI request history
app.get("/api/ai/history", (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const history = aiWorker.getHistory(limit);
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get AI processor stats
app.get("/api/ai/processor/stats", (req, res) => {
  try {
    const stats = aiWorker.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Requeue WordPress sites for AI verification
// Resets ai_status to 'pending' for sites that need re-verification
app.post("/api/ai/requeue", (req, res) => {
  try {
    const database = db.initDatabase();
    
    // Option 1: Requeue all sites with ai_verified_wp = null but ai_status = 'completed'
    const requeueIncomplete = database.prepare(`
      UPDATE sites 
      SET ai_status = 'pending', 
          ai_verified_wp = NULL,
          ai_content_relevant = NULL,
          ai_actual_category = NULL,
          ai_content_summary = NULL,
          ai_mismatch_reason = NULL,
          ai_error = NULL
      WHERE is_wordpress = 1 
        AND ai_status = 'completed' 
        AND ai_verified_wp IS NULL
        AND text_content IS NOT NULL
    `).run();
    
    database.close();
    
    const requeued = requeueIncomplete.changes;
    
    if (requeued > 0) {
      console.log(`🔄 Requeued ${requeued} sites for AI re-verification`);
    }
    
    res.json({ 
      success: true, 
      message: `Requeued ${requeued} sites for AI verification`,
      requeued
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Requeue ALL WordPress sites for fresh AI verification
app.post("/api/ai/requeue-all", (req, res) => {
  try {
    const database = db.initDatabase();
    
    const result = database.prepare(`
      UPDATE sites 
      SET ai_status = 'pending', 
          ai_verified_wp = NULL,
          ai_content_relevant = NULL,
          ai_actual_category = NULL,
          ai_content_summary = NULL,
          ai_mismatch_reason = NULL,
          ai_error = NULL
      WHERE is_wordpress = 1 
        AND text_content IS NOT NULL
    `).run();
    
    database.close();
    
    const requeued = result.changes;
    console.log(`🔄 Requeued ALL ${requeued} WordPress sites for fresh AI verification`);
    
    res.json({ 
      success: true, 
      message: `Requeued ${requeued} WordPress sites for fresh AI verification`,
      requeued
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =====================================================
// SITE ENDPOINTS
// =====================================================

// Get WordPress sites
app.get("/api/sites/wordpress", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const searchQuery = req.query.search || null;
    const result = db.getSitesByWordpressStatus(true, page, limit, searchQuery);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get non-WordPress sites
app.get("/api/sites/non-wordpress", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const searchQuery = req.query.search || null;
    const result = db.getSitesByWordpressStatus(
      false,
      page,
      limit,
      searchQuery,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get distinct AI categories
app.get("/api/sites/categories", (req, res) => {
  try {
    const categories = db.getDistinctCategories();
    res.json({ success: true, data: categories });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all sites with optional search filter and dynamic category filter
app.get("/api/sites/all", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const searchQuery = req.query.search || null;
    const filter = req.query.filter || "all";
    const category = req.query.category || null;
    const result = db.getAllSites(page, limit, searchQuery, filter, category);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get scraper status
app.get("/api/scraper/status", (req, res) => {
  const status = Array.from(runningScrapers.entries()).map(
    ([keywordId, data]) => ({
      keywordId,
      keyword: data.keyword,
      status: data.status,
      progress: data.progress,
      total: data.total,
    }),
  );
  res.json({ success: true, data: status });
});

// Start scraping for a single keyword
app.post("/api/scraper/start/:keywordId", async (req, res) => {
  try {
    const { keywordId } = req.params;
    const keyword = db.getKeywordById(parseInt(keywordId));

    if (!keyword) {
      return res
        .status(404)
        .json({ success: false, error: "Keyword not found" });
    }

    if (runningScrapers.has(parseInt(keywordId))) {
      return res.status(400).json({
        success: false,
        error: "Scraper already running for this keyword",
      });
    }

    // Update keyword status to running
    db.updateKeywordStatus(parseInt(keywordId), "running");

    // Start scraper in background
    runScraper(parseInt(keywordId), keyword.keyword, keyword.max_sites);

    res.json({ success: true, message: "Scraper started" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start scraping for all keywords (sequentially, one by one)
app.post("/api/scraper/start-all", async (req, res) => {
  try {
    const keywords = db.getAllKeywords().filter((k) => k.status !== "running");

    if (keywords.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No keywords available to scrape" });
    }

    // Respond immediately that we're starting
    res.json({
      success: true,
      message: `Started scraping ${keywords.length} keywords one by one`,
    });

    // Run scrapers sequentially (one by one)
    for (const keyword of keywords) {
      if (!runningScrapers.has(keyword.id)) {
        console.log(
          `\n[${keyword.id}] Starting scraper for: ${keyword.keyword}`,
        );
        db.updateKeywordStatus(keyword.id, "running");

        // Wait for this scraper to complete before starting the next
        await runScraper(keyword.id, keyword.keyword, keyword.max_sites);

        console.log(`[${keyword.id}] Completed: ${keyword.keyword}`);
      }
    }

    console.log("\n✅ All scrapers completed!");
  } catch (error) {
    console.error("Error in start-all:", error);
  }
});

// Stop scraper for a single keyword
app.post("/api/scraper/stop/:keywordId", async (req, res) => {
  try {
    const { keywordId } = req.params;

    if (!runningScrapers.has(parseInt(keywordId))) {
      return res
        .status(400)
        .json({ success: false, error: "No scraper running for this keyword" });
    }

    // Remove from running scrapers - the cleanup in runScraper will handle the rest
    runningScrapers.delete(parseInt(keywordId));
    db.updateKeywordStatus(parseInt(keywordId), "pending");

    res.json({ success: true, message: "Scraper stopped" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get search history
app.get("/api/searches", (req, res) => {
  try {
    const searches = db.getAllSearches();
    res.json({ success: true, data: searches });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get search by ID with sites
app.get("/api/searches/:id", (req, res) => {
  try {
    const { id } = req.params;
    const search = db.getSearchById(parseInt(id));
    if (!search) {
      return res
        .status(404)
        .json({ success: false, error: "Search not found" });
    }
    res.json({ success: true, data: search });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export all data to JSON
app.get("/api/export", (req, res) => {
  try {
    const searches = db.getAllSearches();

    const data = searches.map((search) => {
      const searchWithSites = db.getSearchById(search.id);
      return {
        ...search,
        sites: searchWithSites ? searchWithSites.sites : [],
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ SITE API ROUTES ============

// Update site
app.put("/api/sites/:id", (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    const result = db.updateSite(parseInt(id), data);
    if (!result) {
      return res.status(404).json({ success: false, error: "Site not found" });
    }
    res.json({ success: true, message: "Site updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get site deletion preview
app.post("/api/sites/deletion-preview", (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: "No site IDs provided" });
    }
    const preview = db.getSiteDeletionPreview(ids);
    res.json({ success: true, data: preview });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk delete sites (must be before :id route)
app.delete("/api/sites/bulk", (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: "No site IDs provided" });
    }
    const deletedCount = db.bulkDeleteSites(ids);
    res.json({ success: true, deletedCount, message: `Deleted ${deletedCount} site(s)` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete site
app.delete("/api/sites/:id", (req, res) => {
  try {
    const { id } = req.params;
    const result = db.deleteSite(parseInt(id));
    if (!result) {
      return res.status(404).json({ success: false, error: "Site not found" });
    }
    res.json({ success: true, message: "Site deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ CONTACT API ROUTES ============

// Get contact statistics
app.get("/api/contacts/stats", (req, res) => {
  try {
    const stats = db.getContactStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get emails with pagination
app.get("/api/contacts/emails", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || null;
    const result = db.getEmails(page, limit, search);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get phones with pagination
app.get("/api/contacts/phones", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || null;
    const result = db.getPhones(page, limit, search);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all contacts with filtering
app.get("/api/contacts/all", (req, res) => {
  try {
    const type = req.query.type || "all";
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || null;
    const result = db.getAllContacts(type, page, limit, search);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get LinkedIn profiles with pagination
app.get("/api/contacts/linkedin", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || null;
    const result = db.getLinkedinProfiles(page, limit, search);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update contact
app.put("/api/contacts/:id", (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    if (!data.value || data.value.trim() === "") {
      return res
        .status(400)
        .json({ success: false, error: "Value is required" });
    }
    const result = db.updateContact(parseInt(id), data);
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: "Contact not found" });
    }
    res.json({ success: true, message: "Contact updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete contact
app.delete("/api/contacts/:id", (req, res) => {
  try {
    const { id } = req.params;
    const result = db.deleteContact(parseInt(id));
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: "Contact not found" });
    }
    res.json({ success: true, message: "Contact deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ COMPANY EXECUTIVES ROUTES ============

// Get executives statistics
app.get("/api/executives/stats", (req, res) => {
  try {
    const stats = db.getExecutivesStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get company executives with pagination and filtering
app.get("/api/executives", (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || null;
    const role = req.query.role || "all";
    const result = db.getCompanyExecutives(page, limit, search, role);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update executive
app.put("/api/executives/:id", (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    const result = db.updateExecutive(parseInt(id), data);
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: "Executive not found" });
    }
    res.json({ success: true, message: "Executive updated successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete executive
app.delete("/api/executives/:id", (req, res) => {
  try {
    const { id } = req.params;
    const result = db.deleteExecutive(parseInt(id));
    if (!result) {
      return res
        .status(404)
        .json({ success: false, error: "Executive not found" });
    }
    res.json({ success: true, message: "Executive deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk delete keywords
app.delete("/api/keywords/bulk", (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid IDs array" });
    }

    let deletedCount = 0;
    for (const id of ids) {
      const result = db.deleteKeyword(parseInt(id));
      if (result) deletedCount++;
    }

    res.json({ success: true, data: { deleted: deletedCount } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ EXECUTIVE SCRAPER API ROUTES ============

// Get executive scraper status
app.get("/api/executives/scraper/status", (req, res) => {
  res.json({ success: true, data: executiveScraperStatus });
});

// Manually trigger executive scraping
app.post("/api/executives/scraper/start", async (req, res) => {
  if (executiveScraperStatus.running) {
    return res
      .status(400)
      .json({ success: false, error: "Executive scraper already running" });
  }

  // Start scraping in background
  scrapeExecutives().catch((err) =>
    console.error("[Executive Scraper] Error:", err),
  );

  res.json({ success: true, message: "Executive scraping started" });
});

// ============ SCRAPER FUNCTION ============

/**
 * Scrape executives from all LinkedIn company URLs in database
 */
async function scrapeExecutives() {
  if (executiveScraperStatus.running) {
    console.log("[Executive Scraper] Already running, skipping...");
    return;
  }

  executiveScraperStatus.running = true;
  executiveScraperStatus.progress = 0;
  executiveScraperStatus.total = 0;

  try {
    const database = db.initDatabase();

    // Get all LinkedIn URLs from contacts table, excluding those that already have executives
    const companyUrls = database
      .prepare(
        `
      SELECT DISTINCT
        c.value as linkedin_url,
        c.site_id,
        s.url as site_url
      FROM contacts c
      INNER JOIN sites s ON c.site_id = s.id
      WHERE c.type = 'linkedin'
        AND NOT EXISTS (
          SELECT 1 FROM company_executives ce
          WHERE ce.company_url = c.value
        )
    `,
      )
      .all();

    database.close();

    console.log(
      `\n[Executive Scraper] 📊 Found ${
        companyUrls.length
      } LinkedIn company URLs to process (skipping ${
        companyUrls.length === 0
          ? "all - already scraped!"
          : "companies with existing executives"
      }`,
    );
    executiveScraperStatus.total = companyUrls.length;

    if (companyUrls.length === 0) {
      console.log(
        `[Executive Scraper] ✅ All companies already have executives scraped!`,
      );
      return;
    }

    const scraper = new LinkedInCompanyScraper();
    await scraper.init();

    let executivesFound = 0;
    let executivesSaved = 0;

    for (let i = 0; i < companyUrls.length; i++) {
      const company = companyUrls[i];
      executiveScraperStatus.progress = i + 1;

      console.log(
        `\n[Executive Scraper] [${i + 1}/${companyUrls.length}] Processing: ${
          company.linkedin_url
        }`,
      );

      try {
        const result = await scraper.scrapeCompanyPage(
          company.linkedin_url,
          company.site_id,
        );
        if (result.success) {
          executivesFound += result.executivesFound || 0;
          executivesSaved += result.executivesSaved || 0;
        }
      } catch (err) {
        console.error(
          `[Executive Scraper] Error processing ${company.linkedin_url}:`,
          err.message,
        );
        // Try to reinitialize if context was closed
        if (err.message.includes("closed")) {
          try {
            console.log(
              `[Executive Scraper] Browser was closed, reinitializing...`,
            );
            await scraper.init();
          } catch (initErr) {
            console.error(
              `[Executive Scraper] Failed to reinitialize browser:`,
              initErr.message,
            );
            break;
          }
        }
      }

      // Delay between companies
      if (i < companyUrls.length - 1) {
        const delay = Math.floor(Math.random() * 3000) + 5000; // 5-8 seconds
        try {
          await scraper.page.waitForTimeout(delay);
        } catch (waitErr) {
          console.error(
            `[Executive Scraper] Delay interrupted:`,
            waitErr.message,
          );
        }
      }
    }

    // Only close if scraper is still valid
    try {
      await scraper.close();
    } catch (closeErr) {
      console.log(
        `[Executive Scraper] Browser already closed: ${closeErr.message}`,
      );
    }

    console.log(`\n[Executive Scraper] ✅ SUMMARY:`);
    console.log(`   Companies processed: ${companyUrls.length}`);
    console.log(`   Executives found: ${executivesFound}`);
    console.log(`   Executives saved: ${executivesSaved}`);
  } catch (error) {
    console.error(`[Executive Scraper] Error:`, error);
  } finally {
    executiveScraperStatus.running = false;
  }
}

async function runScraper(keywordId, keyword, maxSites = 20) {
  const scraperData = {
    keyword,
    status: "running",
    progress: 0,
    total: 0,
  };
  runningScrapers.set(keywordId, scraperData);

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath:
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: false, // Must be false for persistent context
    channel: "chrome", // Use actual Chrome browser instead of Chromium
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--profile-directory=Default",
    ],
    ignoreDefaultArgs: ["--disable-extensions"],
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    permissions: ["geolocation"],
  });

  try {
    const page = await context.newPage();

    // Navigate to Google
    await page.goto("https://www.google.com", { waitUntil: "networkidle" });

    // Accept cookies if needed
    try {
      const acceptButton = await page.$(
        'button:has-text("Accept all"), button:has-text("I agree")',
      );
      if (acceptButton) {
        await acceptButton.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {}

    // Type search query
    const searchBox = await page.$('textarea[name="q"], input[name="q"]');
    if (searchBox) {
      // Random delay to appear more human
      await page.waitForTimeout(Math.random() * 1000 + 500);

      // Type with random delays between characters
      await searchBox.fill(keyword);
      await page.waitForTimeout(Math.random() * 500 + 200);
      await searchBox.press("Enter");

      await page.waitForSelector("div#search", { timeout: 15000 });

      // Scroll down to load more results naturally
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
      });
      await page.waitForTimeout(1000);

      // Check if CAPTCHA is present
      const captcha = await page.$(
        'form[action*="captcha"] #captcha, textarea[name="captcha"], iframe[src*="captcha"]',
      );
      if (captcha) {
        console.log(
          "[Scraper] ⚠️  CAPTCHA detected! Please solve it in the browser window.",
        );
        console.log("[Scraper] Waiting 30 seconds for CAPTCHA to be solved...");
        await page.waitForTimeout(30000);
      }

      // Extract URLs from multiple pages
      const urls = [];
      const seenUrls = new Set();
      let pageNum = 0;

      // Calculate how many Google pages to turn (assume ~10 results per page, cap at 10 pages)
      const maxPages = Math.min(Math.ceil(maxSites / 10) + 1, 10);

      while (pageNum < maxPages && urls.length < maxSites) {
        console.log(`[Scraper] Scraping Google page ${pageNum + 1}...`);

        // Extract URLs from current page
        const pageUrls = await page.evaluate(() => {
          const results = [];
          const links = document.querySelectorAll("div#search a[href]");

          for (const link of links) {
            const href = link.getAttribute("href");
            if (
              href &&
              !href.includes("google.") &&
              !href.startsWith("#") &&
              !href.startsWith("/url?q=")
            ) {
              if (href.startsWith("http")) {
                const urlWithoutHash = href.split("#")[0];
                results.push(urlWithoutHash);
              }
            }
          }
          return results;
        });

        // Add new URLs
        for (const url of pageUrls) {
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            urls.push(url);
          }
        }

        console.log(
          `[Scraper] Page ${pageNum + 1}: Found ${
            pageUrls.length
          } URLs (Total: ${urls.length} unique)`,
        );

        // If we got very few results, wait a bit (Google might be rate limiting)
        if (pageUrls.length < 5 && pageNum === 0) {
          console.log(
            `[Scraper] ⚠️  Low result count. Google might be rate limiting. Waiting 5 seconds...`,
          );
          await page.waitForTimeout(5000);
        }

        // Check if there's a "Next" button or More results link
        const nextButton = await page.$(
          'a#pnnext, a[aria-label="Next"], a[aria-label="More results"]',
        );

        if (!nextButton || pageNum >= maxPages - 1) {
          console.log(`[Scraper] No more pages available or reached max pages`);
          break;
        }

        // Click next button with random delay
        try {
          await page.waitForTimeout(Math.random() * 2000 + 1000); // Random delay 1-3 seconds
          await nextButton.click();
          await page.waitForTimeout(2000); // Wait for page to load

          // Scroll a bit to appear human
          await page.evaluate(() => {
            window.scrollBy(0, 200);
          });

          await page
            .waitForSelector("div#search", { timeout: 15000 })
            .catch(() => {
              console.log(
                `[Scraper] Page loaded (no explicit #search element)`,
              );
            });
          pageNum++;
        } catch (e) {
          console.log(
            `[Scraper] Could not navigate to next page: ${e.message}`,
          );
          break;
        }
      }

      // Filter out URLs that already exist in the database
      const existingUrls = db.getAllExistingUrls();

      // Track duplicates for logging
      const duplicates = [];
      let newUrls = urls.filter((url) => {
        const normalized = db.normalizeUrl(url);
        if (existingUrls.has(normalized)) {
          duplicates.push(url);
          return false;
        }
        return true;
      });

      // Strictly enforce the maxSites limit on newUrls just in case the last Google page returned too many
      if (newUrls.length > maxSites) {
        newUrls = newUrls.slice(0, maxSites);
      }

      // Filter out URLs from excluded domains
      const excludedDomains = db.getAllExcludedDomains().map(d => d.domain);
      if (excludedDomains.length > 0) {
        const domainExcluded = [];
        newUrls = newUrls.filter(url => {
          if (db.isUrlExcluded(url, excludedDomains)) {
            domainExcluded.push(url);
            return false;
          }
          return true;
        });
        if (domainExcluded.length > 0) {
          console.log(
            `[Scraper] ⛔ Excluded ${domainExcluded.length} URLs (blocked domains):`,
          );
          domainExcluded.forEach(u => console.log(`  ⛔ ${u}`));
        }
      }

      console.log(
        `[Scraper] Found ${urls.length} URLs, ${newUrls.length} new (limited to ${maxSites}), ${duplicates.length} duplicates`,
      );
      if (duplicates.length > 0) {
        console.log(
          `[Scraper] Skipped duplicates:`,
          duplicates.slice(0, 5).join(", ") +
            (duplicates.length > 5 ? "..." : ""),
        );
      }

      scraperData.total = newUrls.length;

      // Check each site with proper logging
      const results = [];
      console.log(
        `\n[Scraper] Starting WordPress detection for ${newUrls.length} sites...`,
      );
      for (let i = 0; i < newUrls.length; i++) {
        scraperData.progress = i + 1;
        console.log(
          `\n================================================================================`,
        );
        console.log(
          `[Scraper] [${i + 1}/${newUrls.length}] Checking: ${newUrls[i]}`,
        );
        const result = await checkWordPress(page, newUrls[i]);
        results.push(result);
      }

      // Save to database
      db.saveSearchResults(keyword, results);

      // Update keyword status
      db.updateKeywordStatus(keywordId, "completed");
      scraperData.status = "completed";

      // Automatically trigger executive scraping
      console.log(
        `\n[Scraper] ✅ Main scraping completed. Starting executive scraping...`,
      );
      setTimeout(() => {
        scrapeExecutives().catch((err) =>
          console.error("[Scraper] Executive scraping error:", err),
        );
      }, 2000); // Start after 2 seconds
    }
  } catch (error) {
    console.error(`Scraper error for keyword ${keyword}:`, error);
    db.updateKeywordStatus(keywordId, "error");
    scraperData.status = "error";
  } finally {
    await context.close();
    runningScrapers.delete(keywordId);
  }
}

/**
 * Wappalyzer-style WordPress detection with advanced confidence scoring
 * Implements multi-layered detection similar to Wappalyzer methodology
 */
async function checkWordPress(page, url) {
  const result = {
    url,
    isWordPress: false,
    confidenceScore: 0,
    confidenceLevel: "LOW",
    indicators: [],
    emails: [],
    phones: [],
    linkedin_profiles: [],
  };

  // Clean URL - remove hash fragment and trailing slash
  let cleanUrl = url.split("#")[0].replace(/\/$/, "");

  // Skip non-HTML resources
  const skipExtensions = [
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".mp4",
    ".mp3",
    ".zip",
    ".xml",
  ];
  if (skipExtensions.some((ext) => cleanUrl.toLowerCase().endsWith(ext))) {
    result.error = "Skipped: Non-HTML resource";
    return result;
  }

  // Wappalyzer-style confidence thresholds
  const CONFIDENCE_THRESHOLDS = {
    IMMEDIATE: 8, // Instant WordPress detection
    HIGH: 6, // Very confident
    MEDIUM: 4, // Moderately confident
    LOW: 2, // Some evidence
    MINIMUM: 5, // Current threshold for positive detection
  };

  // Helper function to add indicator with confidence score
  const addIndicator = (name, score, category = "DETECTION") => {
    result.indicators.push({
      name,
      score,
      category,
      timestamp: new Date().toISOString(),
    });
    result.confidenceScore += score;
  };

  // Helper function to calculate confidence level
  const calculateConfidenceLevel = () => {
    const totalScore = result.confidenceScore;
    const strongEvidence = result.indicators.filter((i) => i.score >= 4).length;
    const multipleEvidence = result.indicators.length >= 3;

    // Immediate detection for very strong evidence
    if (strongEvidence >= 2 || totalScore >= CONFIDENCE_THRESHOLDS.IMMEDIATE) {
      return "IMMEDIATE";
    }

    // High confidence with multiple strong indicators
    if (
      strongEvidence >= 1 &&
      multipleEvidence &&
      totalScore >= CONFIDENCE_THRESHOLDS.HIGH
    ) {
      return "HIGH";
    }

    // Medium confidence
    if (totalScore >= CONFIDENCE_THRESHOLDS.MEDIUM) {
      return "MEDIUM";
    }

    return "LOW";
  };

  // URL path check - only MEDIUM confidence (not immediate detection)
  const urlWordPressPatterns = [
    { pattern: /\/wp-content\//i, score: 2 },
    { pattern: /\/wp-includes\//i, score: 2 },
    { pattern: /\/wp-admin\//i, score: 2 },
    { pattern: /\/wp-json\//i, score: 1 },
    { pattern: /\/wp-login\.php/i, score: 2 },
  ];

  for (const { pattern, score } of urlWordPressPatterns) {
    if (pattern.test(cleanUrl)) {
      addIndicator(`WordPress path in URL (${pattern.source})`, score);
      break; // Only count URL path once
    }
  }

  try {
    // ========== CHECK 1: robots.txt (WEAK indicator - can be copied) ==========
    try {
      const robotsUrl = new URL("/robots.txt", cleanUrl).href;
      const robotsResponse = await page.goto(robotsUrl, {
        waitUntil: "domcontentloaded",
        timeout: 5000,
      });
      if (robotsResponse && robotsResponse.status() === 200) {
        const robotsContent = await robotsResponse.text();
        // More specific patterns - require disallow directives
        if (
          /Disallow:\s*\/wp-admin/i.test(robotsContent) ||
          /Disallow:\s*\/wp-includes/i.test(robotsContent) ||
          /Disallow:\s*\/wp-content/i.test(robotsContent)
        ) {
          addIndicator("WordPress paths in robots.txt", 1);
        }
      }
    } catch (e) {
      // robots.txt check failed, continue with other checks
    }

    // ========== CHECK 2: /wp-json endpoint with proper validation (STRONG) ==========
    try {
      const wpJsonUrl = new URL("/wp-json", cleanUrl).href;
      const wpJsonResponse = await page.goto(wpJsonUrl, {
        waitUntil: "domcontentloaded",
        timeout: 5000,
      });
      if (wpJsonResponse) {
        const contentType = wpJsonResponse.headers()["content-type"] || "";
        if (
          wpJsonResponse.status() === 200 &&
          contentType.includes("application/json")
        ) {
          try {
            const jsonContent = await wpJsonResponse.json();
            // Validate it's actual WordPress REST API structure
            if (
              jsonContent &&
              jsonContent.name &&
              jsonContent.url &&
              jsonContent.routes
            ) {
              addIndicator("WordPress REST API endpoint (validated)", 4);
            } else if (
              jsonContent &&
              jsonContent.description &&
              typeof jsonContent.routes === "object"
            ) {
              addIndicator("WordPress REST API endpoint (partial)", 2);
            }
          } catch (e) {
            // Can't parse JSON - might not be WordPress
            // Just having /wp-json return 200 is weak indicator
            addIndicator("WordPress REST API endpoint (unvalidated)", 1);
          }
        }
      }
    } catch (e) {
      // wp-json check failed, continue
    }

    // Navigate to the site
    const response = await page.goto(cleanUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    if (!response) {
      return result;
    }

    // ========== CHECK 3: Server Headers (MEDIUM - can be faked) ==========
    const headers = response.headers();
    const server = headers["server"] || "";
    const poweredBy = headers["x-powered-by"] || "";

    // More specific WordPress hosting signatures
    if (/wp-engine/i.test(server)) {
      addIndicator(`WP Engine hosting (${server})`, 3);
    } else if (/kinsta|pagely/i.test(server)) {
      addIndicator(`WordPress hosting (${server})`, 2);
    } else if (/flywheel/i.test(server)) {
      addIndicator(`Flywheel hosting (${server})`, 2);
    }

    // Check for REST API in Link header (STRONG)
    if (headers["link"] && headers["link"].includes("wp-json")) {
      addIndicator("WordPress REST API in Link header", 3);
    }

    // Check content type - skip non-HTML
    const contentType = headers["content-type"] || "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml")
    ) {
      result.error = `Skipped: Non-HTML content type (${contentType})`;
      return result;
    }

    // Get the page HTML
    const content = await page.content();

    // ========== CHECK 4: JavaScript Runtime Detection (Wappalyzer-style) ==========
    try {
      const jsIndicators = await detectWordPressRuntime(page);
      jsIndicators.forEach((indicator) => {
        addIndicator(indicator.name, indicator.score, "JAVASCRIPT");
      });
    } catch (e) {
      // JavaScript detection failed, continue with other checks
    }

    // ========== CHECK 5: DOM Structure Detection (Wappalyzer-style) ==========
    try {
      const domIndicators = await detectWordPressDOM(page);
      domIndicators.forEach((indicator) => {
        addIndicator(indicator.name, indicator.score, "DOM");
      });
    } catch (e) {
      // DOM detection failed, continue with other checks
    }

    // ========== CHECK 6: Network Request Monitoring (Wappalyzer-style) ==========
    try {
      const networkIndicators = await detectWordPressNetworkRequests(page);
      networkIndicators.forEach((indicator) => {
        addIndicator(indicator.name, indicator.score, "NETWORK");
      });
    } catch (e) {
      // Network monitoring failed, continue with other checks
    }

    // ========== CHECK 7: WordPress Cookies (WEAK - third-party cookies) ==========
    const cookies = await page.context().cookies();
    let foundWordPressCookie = false;
    for (const cookie of cookies) {
      // Only count first-party cookies (same domain)
      if (
        cookie.domain &&
        (cookie.domain.includes("wordpress") ||
          cookie.name === "wp-settings-time" ||
          cookie.name.startsWith("wordpress_logged_in_") ||
          cookie.name.startsWith("wp_"))
      ) {
        // Check it's for the current domain, not third-party
        const cookieDomain = cookie.domain.replace(/^\./, "");
        const urlDomain = new URL(cleanUrl).hostname;
        if (
          urlDomain.endsWith(cookieDomain) ||
          cookieDomain.endsWith(urlDomain)
        ) {
          addIndicator(`WordPress cookie (${cookie.name})`, 1);
          foundWordPressCookie = true;
          break; // Only count once
        }
      }
    }

    // ========== CHECK 8: HTML Content Indicators (Wappalyzer-style) ==========
    // Each indicator has specific patterns and confidence scores

    const wordpressIndicators = [
      // STRONG indicators (3-4 points)
      {
        name: "WordPress meta generator tag",
        score: 4,
        check: () =>
          /<meta\s+name=["']generator["']\s+content=["']WordPress\s+\d/i.test(
            content,
          ),
      },
      {
        name: "WordPress REST API discovery link",
        score: 3,
        check: () => /rel=["']https:\/\/api\.w\.org\/["']/i.test(content),
      },
      {
        name: "WordPress oEmbed discovery",
        score: 3,
        check: () =>
          /rel=["']alternate["']\s+type=["']application\/json\+oembed\+embed["']/i.test(
            content,
          ) ||
          /rel=["']alternate["']\s+type=["']application\/json\+oembed["']/i.test(
            content,
          ),
      },
      {
        name: "WordPress Gutenberg blocks",
        score: 3,
        check: () =>
          /class=["']wp-block-|has-medium-font-size|has-large-font-size|is-layout-constrained|is-layout-flow["']/i.test(
            content,
          ),
      },
      {
        name: "wp-emoji-release.min.js",
        score: 3,
        check: () => /wp-emoji-release\.min\.js/i.test(content),
      },

      // MEDIUM indicators (2 points)
      {
        name: "wp-includes in source",
        score: 2,
        check: () => /\/wp-includes\//i.test(content),
      },
      {
        name: "wp-content in source",
        score: 2,
        check: () => /\/wp-content\//i.test(content),
      },
      {
        name: "WordPress admin link",
        score: 2,
        check: () => /href=["'][^"']*\/wp-admin\//i.test(content),
      },
      {
        name: "WordPress inline scripts",
        score: 2,
        check: () => /wp-embed\.min\.js|wp-util\.js|wp-i18n\.js/i.test(content),
      },
      {
        name: "WordPress RSS feeds",
        score: 2,
        check: () =>
          /href=["'][^"']*\/feed\/\?["']/i.test(content) ||
          /type=["']application\/rss\+xml["']/i.test(content),
      },
      {
        name: "Classic WordPress theme classes",
        score: 2,
        check: () =>
          /wp-caption\s+align|wp-post-image|gallery-item|wp-gallery/i.test(
            content,
          ),
      },
      {
        name: "wlwmanifest.xml link",
        score: 2,
        check: () => /href=["'][^"']*wlwmanifest\.xml["']/i.test(content),
      },

      // WEAK indicators (1 point)
      {
        name: "WordPress shortlink",
        score: 1,
        check: () =>
          /rel=["']shortlink["']/i.test(content) ||
          /href=["']\?p=\d+["']/i.test(content),
      },
      {
        name: "Generic wp- patterns",
        score: 1,
        check: () =>
          /wp-|wordpress/i.test(content) &&
          !/<iframe|<object|embed|third-party/i.test(content),
      },
    ];

    // Check each indicator and add score
    for (const indicator of wordpressIndicators) {
      if (indicator.check()) {
        addIndicator(indicator.name, indicator.score);
      }
    }

    // Negative patterns - subtract confidence if found
    const negativePatterns = [
      {
        name: "Explicitly NOT WordPress",
        pattern:
          /powered by (joomla|drupal|magento|shopify|squarespace|wix|blogger|tumblr)/i,
        penalty: 10,
      },
      {
        name: "Generator tag shows different CMS",
        pattern:
          /<meta\s+name=["']generator["']\s+content=["'](?!WordPress)([^"']+)/i,
        penalty: 8,
      },
      {
        name: "Static site generator",
        pattern: /static|gatsby|next\.js|nuxt|vuepress|hugo|jekyll/i,
        penalty: 5,
      },
    ];

    for (const { name, pattern, penalty } of negativePatterns) {
      if (pattern.test(content)) {
        result.indicators.push(`NEGATIVE: ${name}`);
        result.confidenceScore -= penalty;
      }
    }

    // Final determination based on enhanced confidence scoring
    result.confidenceLevel = calculateConfidenceLevel();
    result.isWordPress =
      result.confidenceScore >= CONFIDENCE_THRESHOLDS.MINIMUM;

    // Log confidence score and indicators for debugging
    if (result.indicators.length > 0) {
      console.log(
        `      📊 Confidence Score: ${result.confidenceScore}/${CONFIDENCE_THRESHOLDS.MINIMUM} (${result.confidenceLevel})`,
      );
      console.log(
        `      🔍 Indicators: ${result.indicators.slice(0, 5).join(", ")}${
          result.indicators.length > 5 ? "..." : ""
        }`,
      );
    }

    // ========== CONTACT EXTRACTION (ONLY FOR WORDPRESS SITES) ==========
    if (result.isWordPress) {
      console.log(
        `      ✓ WordPress detected (score: ${result.confidenceScore}) - extracting contacts & text...`,
      );

      // Extract text content for AI processing
      try {
        const pageText = await page.evaluate(() => {
          // Remove scripts and styles before getting text
          const scripts = document.querySelectorAll("script, style, noscript");
          scripts.forEach((s) => s.remove());

          return document.body.innerText || document.body.textContent || "";
        });

        // Clean up text and limit to ~3000 chars to save tokens
        result.text_content = pageText
          .replace(/[\r\n\t]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 3000);
      } catch (e) {
        console.log(`      ⚠️  Could not extract text content: ${e.message}`);
      }

      const allEmails = new Set();
      const allPhones = new Set();
      const allLinkedIns = new Set();

      // Extract from homepage
      const homepageEmails = extractEmails(content);
      const homepagePhones = extractPhones(content);
      const homepageLinkedIns = extractLinkedIn(content);

      homepageEmails.forEach((email) => allEmails.add(email));
      homepagePhones.forEach((phone) => allPhones.add(phone));
      homepageLinkedIns.forEach((linkedin) => allLinkedIns.add(linkedin));

      // Find and visit contact page for more contacts
      const contactUrl = await findContactPage(page, cleanUrl);
      if (contactUrl && contactUrl !== cleanUrl) {
        console.log(`      → Visiting contact page: ${contactUrl}`);
        try {
          const contactResponse = await page.goto(contactUrl, {
            waitUntil: "domcontentloaded",
            timeout: 10000,
          });

          if (contactResponse) {
            const contactContent = await page.content();

            const contactEmails = extractEmails(contactContent);
            const contactPhones = extractPhones(contactContent);
            const contactLinkedIns = extractLinkedIn(contactContent);

            contactEmails.forEach((email) => allEmails.add(email));
            contactPhones.forEach((phone) => allPhones.add(phone));
            contactLinkedIns.forEach((linkedin) => allLinkedIns.add(linkedin));
          }
        } catch (e) {
          console.log(`      ⚠️  Could not load contact page: ${e.message}`);
        }
      }

      result.emails = Array.from(allEmails);
      result.phones = Array.from(allPhones);
      result.linkedin_profiles = Array.from(allLinkedIns);

      if (
        result.emails.length > 0 ||
        result.phones.length > 0 ||
        result.linkedin_profiles.length > 0
      ) {
        console.log(
          `      ✅ Found ${result.emails.length} emails, ${result.phones.length} phones, ${result.linkedin_profiles.length} LinkedIn profiles`,
        );
      }
    } else {
      if (result.confidenceScore > 0) {
        console.log(
          `      ✗ Not WordPress (score: ${result.confidenceScore}/${CONFIDENCE_THRESHOLDS.MINIMUM}) - insufficient confidence`,
        );
      } else {
        console.log(
          `      ✗ Not WordPress (score: 0) - no specific indicators found`,
        );
      }
    }
  } catch (error) {
    result.error = error.message;
    // Don't log every timeout error since many sites blocking headless browsers will timeout
    if (!error.message.includes("Timeout")) {
      console.log(`      ⚠️  Check failed: ${error.message}`);
    }
  }

  return result;
}

/**
 * Wappalyzer-style JavaScript runtime detection for WordPress
 * Checks for global JavaScript variables and objects exposed by WordPress
 * @param {Page} page - Playwright page object
 * @returns {Promise<Array>} - Array of detected JavaScript indicators
 */
async function detectWordPressRuntime(page) {
  const jsIndicators = [];

  try {
    // Check for WordPress global objects and variables
    const jsChecks = [
      {
        name: "WordPress global object (window.wp)",
        check: () => page.evaluate(() => typeof window.wp !== "undefined"),
        score: 4,
      },
      {
        name: "WordPress jQuery",
        check: () =>
          page.evaluate(
            () =>
              typeof window.jQuery !== "undefined" && window.jQuery.fn.jquery,
          ),
        score: 3,
      },
      {
        name: "WordPress REST API settings",
        check: () =>
          page.evaluate(() => typeof window.wpApiSettings !== "undefined"),
        score: 3,
      },
      {
        name: "WordPress admin bar",
        check: () =>
          page.evaluate(() => document.getElementById("wpadminbar") !== null),
        score: 2,
      },
      {
        name: "WordPress localized scripts",
        check: () =>
          page.evaluate(
            () =>
              typeof window.wp_json !== "undefined" ||
              typeof window.wpApiSettings !== "undefined",
          ),
        score: 3,
      },
      {
        name: "WordPress nonce",
        check: () =>
          page.evaluate(
            () =>
              document.querySelector("[data-wp-nonce]") !== null ||
              document.querySelector('input[name="_wpnonce"]') !== null,
          ),
        score: 2,
      },
      {
        name: "WordPress comment form",
        check: () =>
          page.evaluate(() => document.querySelector("#commentform") !== null),
        score: 1,
      },
      {
        name: "WordPress shortcodes",
        check: () =>
          page.evaluate(
            () => document.querySelector("[data-wp-shortcode]") !== null,
          ),
        score: 2,
      },
    ];

    // Execute all JavaScript checks in parallel for better performance
    const results = await Promise.all(
      jsChecks.map(async (check) => {
        try {
          const detected = await check.check();
          return detected ? { name: check.name, score: check.score } : null;
        } catch (e) {
          return null;
        }
      }),
    );

    // Filter out null results and add to indicators
    results.forEach((result) => {
      if (result) {
        jsIndicators.push(result);
      }
    });
  } catch (error) {
    console.log(`  ⚠️  JavaScript detection failed: ${error.message}`);
  }

  return jsIndicators;
}

/**
 * Wappalyzer-style DOM structure detection for WordPress
 * Checks for specific DOM patterns and structures unique to WordPress
 * @param {Page} page - Playwright page object
 * @returns {Promise<Array>} - Array of detected DOM indicators
 */
async function detectWordPressDOM(page) {
  const domIndicators = [];

  try {
    const domChecks = [
      {
        name: "Gutenberg blocks",
        check: () =>
          page.evaluate(() => document.querySelector(".wp-block-") !== null),
        score: 3,
      },
      {
        name: "WordPress shortcodes",
        check: () =>
          page.evaluate(
            () => document.querySelector("[data-wp-shortcode]") !== null,
          ),
        score: 2,
      },
      {
        name: "WordPress nonce",
        check: () =>
          page.evaluate(
            () => document.querySelector("[data-wp-nonce]") !== null,
          ),
        score: 2,
      },
      {
        name: "WordPress comment form",
        check: () =>
          page.evaluate(() => document.querySelector("#commentform") !== null),
        score: 1,
      },
      {
        name: "WordPress gallery",
        check: () =>
          page.evaluate(() => document.querySelector(".gallery-item") !== null),
        score: 2,
      },
      {
        name: "WordPress caption",
        check: () =>
          page.evaluate(() => document.querySelector(".wp-caption") !== null),
        score: 1,
      },
    ];

    // Execute all DOM checks in parallel
    const results = await Promise.all(
      domChecks.map(async (check) => {
        try {
          const detected = await check.check();
          return detected ? { name: check.name, score: check.score } : null;
        } catch (e) {
          return null;
        }
      }),
    );

    // Filter out null results and add to indicators
    results.forEach((result) => {
      if (result) {
        domIndicators.push(result);
      }
    });
  } catch (error) {
    console.log(`  ⚠️  DOM detection failed: ${error.message}`);
  }

  return domIndicators;
}

/**
 * Wappalyzer-style network request monitoring for WordPress
 * Monitors outgoing network requests for WordPress-specific patterns
 * @param {Page} page - Playwright page object
 * @returns {Promise<Array>} - Array of detected network indicators
 */
async function detectWordPressNetworkRequests(page) {
  const networkIndicators = [];
  let networkMonitoringActive = false;

  try {
    // Start monitoring network requests
    page.on("response", (response) => {
      if (!networkMonitoringActive) return;

      const url = response.url();
      const status = response.status();

      if (url.includes("/wp-admin/admin-ajax.php") && status === 200) {
        networkIndicators.push({ name: "WordPress AJAX endpoint", score: 3 });
      }

      if (url.includes("/wp-json/") && status === 200) {
        networkIndicators.push({ name: "WordPress REST API call", score: 4 });
      }

      if (url.includes("/wp-content/uploads/") && status === 200) {
        networkIndicators.push({ name: "WordPress media request", score: 2 });
      }
    });

    // Activate monitoring
    networkMonitoringActive = true;

    // Wait for page to load and network to settle
    await page.waitForLoadState("networkidle", { timeout: 10000 });

    // Deactivate monitoring after a short delay
    setTimeout(() => {
      networkMonitoringActive = false;
    }, 2000);
  } catch (error) {
    if (!error.message.includes("Timeout")) {
      // Don't log timeouts as they're common and expected on many sites
      console.log(`  ⚠️  Network monitoring error: ${error.message}`);
    }
  }

  return networkIndicators;
}

/**
 * Wappalyzer-style advanced cookie analysis for WordPress
 * Analyzes cookies for WordPress-specific patterns and signatures
 * @param {Page} page - Playwright page object
 * @returns {Promise<Array>} - Array of detected cookie indicators
 */
async function detectWordPressCookies(page) {
  const cookieIndicators = [];

  try {
    const cookies = await page.context().cookies();

    const wordpressCookiePatterns = [
      {
        pattern: /^wordpress_logged_in_/,
        name: "WordPress login cookie",
        score: 3,
      },
      { pattern: /^wp-settings-/, name: "WordPress settings cookie", score: 2 },
      { pattern: /^wp-postpass_/, name: "WordPress password cookie", score: 2 },
      {
        pattern: /^comment_author_/,
        name: "WordPress comment cookie",
        score: 1,
      },
      { pattern: /^wp_/, name: "WordPress generic cookie", score: 1 },
    ];

    for (const cookie of cookies) {
      for (const pattern of wordpressCookiePatterns) {
        if (pattern.pattern.test(cookie.name)) {
          cookieIndicators.push({
            name: pattern.name,
            score: pattern.score,
            cookie: cookie.name,
          });
          break; // Only count each cookie once
        }
      }
    }
  } catch (error) {
    console.log(`  ⚠️  Cookie analysis failed: ${error.message}`);
  }

  return cookieIndicators;
}

// Mount email system routes (already mounted above)
// app.use("/api/email", emailRouter);

// Start email queue worker
worker.start();

// Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Admin Panel running at http://localhost:${PORT}`);
  console.log(`📊 Use the web interface to manage keywords and run scrapers\n`);
});
