/**
 * AI Processor Worker - Simplified
 * 
 * Processes WordPress-labeled sites with AI to:
 * 1. Verify if it's actually WordPress
 * 2. Check if content is relevant to the search keyword
 * 3. Generate a short content summary
 * 
 * Only processes sites where is_wordpress = 1
 * 
 * Auto-polling: Checks for pending sites every POLL_INTERVAL_MS.
 * Conflict prevention: While processing a batch, polling is paused.
 */

require("dotenv").config();
const db = require("./database");
const aiClient = require("./ai-client");

const BATCH_SIZE = 5;              // Sites per batch
const POLL_INTERVAL_MS = 30000;    // Check for pending sites every 30 seconds
const SITE_DELAY_MS = 2000;        // 2 seconds between sites (rate limit protection)
const MAX_HISTORY_SIZE = 100;      // Keep last 100 AI requests

class AIProcessor {
  constructor() {
    this.isRunning = false;
    this.isProcessing = false;     // Prevents overlapping batch processing
    this.pollIntervalId = null;
    this.requestHistory = [];      // Track recent AI requests
    this.stats = {
      totalProcessed: 0,
      verified: 0,
      notWordPress: 0,
      relevant: 0,
      notRelevant: 0,
      failed: 0,
      lastPollAt: null,
      lastProcessedAt: null,
    };
  }

  /**
   * Add a request to history
   */
  addToHistory(entry) {
    this.requestHistory.unshift({
      ...entry,
      timestamp: new Date().toISOString()
    });
    // Keep only the most recent entries
    if (this.requestHistory.length > MAX_HISTORY_SIZE) {
      this.requestHistory = this.requestHistory.slice(0, MAX_HISTORY_SIZE);
    }
  }

  /**
   * Get request history
   */
  getHistory(limit = 20) {
    return this.requestHistory.slice(0, limit);
  }

  /**
   * Start the background worker with auto-polling
   */
  start() {
    if (this.isRunning) {
      console.log("⚠️  AI Processor: Already running");
      return;
    }

    if (!aiClient.isConfigured()) {
      console.log("⚠️  AI Processor: OPENROUTER_API_KEY not set. Worker disabled.");
      return;
    }

    this.isRunning = true;
    console.log("\n🤖 AI Processor: Started");
    console.log(`   Model: ${aiClient.getStats().model}`);
    console.log(`   Poll Interval: ${POLL_INTERVAL_MS / 1000}s`);
    console.log(`   Batch Size: ${BATCH_SIZE}`);

    // Check backlog immediately on start
    const pending = this.getPendingCount();
    if (pending > 0) {
      console.log(`   📋 Found ${pending} WordPress sites pending AI verification`);
    } else {
      console.log("   ✓ No pending sites. Watching for new scrapes...");
    }

    // Start polling loop
    this.startPolling();
  }

  /**
   * Start the polling loop
   */
  startPolling() {
    // Process immediately on start
    this.checkAndProcess();
    
    // Then set up interval for future checks
    this.pollIntervalId = setInterval(() => {
      this.checkAndProcess();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Check for pending sites and process if found
   * This is the main polling function called every POLL_INTERVAL_MS
   */
  async checkAndProcess() {
    if (!this.isRunning) return;
    
    // Skip if already processing a batch (conflict prevention)
    if (this.isProcessing) {
      console.log("   ⏸️  Skipping poll - batch still processing");
      return;
    }

    this.stats.lastPollAt = new Date().toISOString();
    const pendingCount = this.getPendingCount();
    
    if (pendingCount === 0) {
      // Silent - don't log when nothing to do
      return;
    }

    console.log(`\n🔍 Poll: Found ${pendingCount} pending sites`);
    await this.processBatch();
  }

  /**
   * Process a batch of pending sites
   */
  async processBatch() {
    if (this.isProcessing) return;
    
    this.isProcessing = true;
    
    try {
      const pendingSites = this.getPendingSites(BATCH_SIZE);

      if (pendingSites.length === 0) {
        return;
      }

      console.log(`🤖 Processing batch of ${pendingSites.length} sites...`);

      for (const site of pendingSites) {
        if (!this.isRunning) break;
        await this.processSite(site);
        
        // Rate limit protection between sites
        await this.sleep(SITE_DELAY_MS);
      }

      this.stats.lastProcessedAt = new Date().toISOString();
      
      // Check if more sites are waiting
      const remaining = this.getPendingCount();
      if (remaining > 0) {
        console.log(`   📋 ${remaining} more sites pending - will process next poll`);
      } else {
        console.log("   ✓ All pending sites processed");
      }

    } catch (error) {
      console.error("❌ AI Processor batch error:", error.message);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Stop the worker
   */
  stop() {
    this.isRunning = false;
    this.isProcessing = false;
    
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    
    console.log("🤖 AI Processor: Stopped");
    this.printStats();
  }

  /**
   * Print processing statistics
   */
  printStats() {
    console.log("\n📊 AI Processor Stats:");
    console.log(`   Total Processed: ${this.stats.totalProcessed}`);
    console.log(`   Verified WordPress: ${this.stats.verified}`);
    console.log(`   Not WordPress: ${this.stats.notWordPress}`);
    console.log(`   Content Relevant: ${this.stats.relevant}`);
    console.log(`   Content Not Relevant: ${this.stats.notRelevant}`);
    console.log(`   Failed: ${this.stats.failed}`);
  }

  /**
   * Get count of pending sites
   */
  getPendingCount() {
    const database = db.initDatabase();
    try {
      const result = database.prepare(`
        SELECT COUNT(*) as count
        FROM sites 
        WHERE is_wordpress = 1 
          AND (ai_status = 'pending' OR ai_status IS NULL)
          AND text_content IS NOT NULL 
          AND text_content != ''
      `).get();
      return result.count;
    } finally {
      database.close();
    }
  }

  /**
   * Get pending WordPress sites that need AI verification
   * Only gets sites where:
   * - is_wordpress = 1 (labeled as WordPress)
   * - ai_status = 'pending' (not yet processed)
   * - text_content is not empty
   */
  getPendingSites(limit = BATCH_SIZE) {
    const database = db.initDatabase();
    try {
      const sites = database.prepare(`
        SELECT id, url, search_query, text_content
        FROM sites 
        WHERE is_wordpress = 1 
          AND (ai_status = 'pending' OR ai_status IS NULL)
          AND text_content IS NOT NULL 
          AND text_content != ''
        ORDER BY id ASC
        LIMIT ?
      `).all(limit);
      return sites;
    } finally {
      database.close();
    }
  }

  /**
   * Process a single site with AI
   */
  async processSite(site) {
    const startTime = Date.now();
    
    try {
      process.stdout.write(`   → [${site.id}] ${this.truncateUrl(site.url)} `);

      // Mark as processing
      this.updateSiteStatus(site.id, "processing");

      // Run AI analysis
      const result = await aiClient.analyzeSite(
        site.search_query,
        site.url,
        site.text_content
      );

      const elapsed = Date.now() - startTime;

      // Track this request in history
      this.addToHistory({
        type: 'site_analysis',
        provider: 'OpenRouter',
        model: aiClient.getStats().model,
        success: true,
        responseTime: elapsed,
        tokens: result.tokensUsed || 0,
        siteUrl: site.url,
        isWordPress: result.isWordPress,
        isRelevant: result.isRelevant
      });

      // Save results
      this.saveAIResults(site.id, result);

      // Update stats
      this.stats.totalProcessed++;
      if (result.isWordPress) {
        this.stats.verified++;
      } else {
        this.stats.notWordPress++;
      }
      if (result.isRelevant) {
        this.stats.relevant++;
      } else {
        this.stats.notRelevant++;
      }

      // Log result
      const wpIcon = result.isWordPress ? "✅" : "❌";
      const relevantIcon = result.isRelevant ? "✅" : "⚠️";
      console.log(`${wpIcon} WP | ${relevantIcon} Relevant | ${result.actualCategory} (${elapsed}ms)`);

      if (!result.isRelevant && result.mismatchReason) {
        console.log(`      ↳ ${result.mismatchReason}`);
      }

    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.log(`❌ Failed: ${error.message}`);
      this.stats.totalProcessed++;
      this.stats.failed++;
      this.updateSiteStatus(site.id, "failed", error.message);
      
      // Track failed request in history
      this.addToHistory({
        type: 'site_analysis',
        provider: 'OpenRouter',
        model: aiClient.getStats().model,
        success: false,
        responseTime: elapsed,
        tokens: 0,
        siteUrl: site.url,
        error: error.message
      });
    }
  }

  /**
   * Update site AI status
   */
  updateSiteStatus(siteId, status, errorMessage = null) {
    const database = db.initDatabase();
    try {
      if (errorMessage) {
        database.prepare(`
          UPDATE sites 
          SET ai_status = ?, ai_error = ?
          WHERE id = ?
        `).run(status, errorMessage, siteId);
      } else {
        database.prepare(`
          UPDATE sites SET ai_status = ? WHERE id = ?
        `).run(status, siteId);
      }
    } finally {
      database.close();
    }
  }

  /**
   * Save AI analysis results to database
   */
  saveAIResults(siteId, result) {
    const database = db.initDatabase();
    try {
      database.prepare(`
        UPDATE sites SET
          ai_status = 'completed',
          ai_error = NULL,
          ai_verified_wp = ?,
          ai_wp_confidence = ?,
          ai_wp_indicators = ?,
          ai_content_relevant = ?,
          ai_actual_category = ?,
          ai_content_summary = ?,
          ai_mismatch_reason = ?,
          ai_processed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        result.isWordPress ? 1 : 0,
        result.wpConfidence || null,
        JSON.stringify(result.wpIndicators || []),
        result.isRelevant ? 1 : 0,
        result.actualCategory || null,
        result.contentSummary || null,
        result.mismatchReason || null,
        siteId
      );
    } finally {
      database.close();
    }
  }

  /**
   * Truncate URL for display
   */
  truncateUrl(url, maxLength = 50) {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + "...";
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current stats (for API)
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isProcessing: this.isProcessing,
      pendingCount: this.getPendingCount(),
      pollIntervalMs: POLL_INTERVAL_MS,
      batchSize: BATCH_SIZE,
      aiClient: aiClient.getStats(),
    };
  }
}

// Export singleton
module.exports = new AIProcessor();
