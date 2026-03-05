/**
 * LinkedIn Company Scraper
 * Extracts founders, co-founders, and CEOs from LinkedIn company pages
 */

const { chromium } = require("playwright");
const path = require("path");

// Delay configurations (in milliseconds)
const MIN_DELAY = 2000;
const MAX_DELAY = 4000;

// Random delay helper
function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class LinkedInCompanyScraper {
  static context = null;
  static page = null;

  async init() {
    console.log("🔐 Initializing browser for LinkedIn company scraping...");

    // Use the same persistent context as WordPress detector
    this.context = await chromium.launchPersistentContext(
      "C:\\automation_chrome",
      {
        executablePath:
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        headless: false,
        channel: "chrome",
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
      },
    );

    // Get or create page
    const pages = this.context.pages();
    if (pages.length > 0) {
      this.page = pages[0];
    } else {
      this.page = await this.context.newPage();
    }

    // Inject anti-detection scripts
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
      window.chrome = { runtime: {} };
    });

    console.log("✅ Browser context created successfully");
  }

  async close() {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
  }

  /**
   * Scrape company LinkedIn page for executives
   * @param {string} companyUrl - LinkedIn company URL
   * @param {number} siteId - Database site ID
   * @returns {Object} Scraping results
   */
  async scrapeCompanyPage(companyUrl, siteId) {
    try {
      console.log(`\n🏢 Scraping company: ${companyUrl}`);

      // Check if browser context is still valid
      if (!this.context || this.context.browser()?.isConnected() === false) {
        console.log(`⚠️  Browser context closed, reinitializing...`);
        await this.init();
      }

      // Check if page is still valid
      if (!this.page || this.page.isClosed()) {
        console.log(`⚠️  Page closed, creating new page...`);
        const pages = this.context.pages();
        if (pages.length > 0) {
          this.page = pages[0];
        } else {
          this.page = await this.context.newPage();
        }
      }

      // Build the executives search URL directly
      // Pattern: {companyUrl}/people/?keywords=founder%2C%20co-founder%2C%20ceo%2C%20cto
      const peopleUrl =
        companyUrl.replace(/\/$/, "") +
        "/people/?keywords=founder%2C%20co-founder%2C%20ceo%2C%20cto";
      console.log(`👥 Direct URL: ${peopleUrl}`);

      // Navigate directly to the filtered people page
      console.log(`📄 Navigating to filtered people page...`);
      await this.page.goto(peopleUrl, {
        waitUntil: "networkidle",
        timeout: 60000,
      });

      // Wait for page to load
      await this.page.waitForTimeout(randomDelay(3000, 5000));

      // Check if we're logged in
      const currentUrl = this.page.url();
      if (currentUrl.includes("login") || currentUrl.includes("checkpoint")) {
        throw new Error("Not logged in to LinkedIn. Please login first.");
      }

      // Wait for results to load
      console.log(`⏳ Waiting for people results to load...`);
      try {
        await this.page.waitForSelector(
          'a[href*="/in/"], .org-people-profile-card, .entity-result__item',
          {
            timeout: 10000,
          },
        );
        console.log(`✅ People results loaded`);
      } catch (e) {
        console.log(
          `⚠️  Could not detect people results, continuing anyway...`,
        );
      }

      // Extract company name from the page
      const companyInfo = await this.extractCompanyInfo();
      console.log(`📊 Company: ${companyInfo.name || "Unknown"}`);

      // Debug: Check what's on the page
      const pageInfo = await this.page.evaluate(() => {
        return {
          totalLinks: document.querySelectorAll("a").length,
          profileLinks: document.querySelectorAll('a[href*="/in/"]').length,
          title: document.title,
          url: window.location.href,
        };
      });
      console.log(`📊 Page info:`, pageInfo);

      // Extract executives from the people page
      const allExecutives = await this.extractExecutives();
      console.log(`📋 Raw matches found: ${allExecutives.length}`);

      // Post-process: select exactly up to 3 founders + 1 CEO + 1 CTO
      const executives = this.selectStructuredExecutives(allExecutives);
      console.log(`✅ Selected ${executives.length} structured executives (3 Founders + 1 CEO + 1 CTO)`);

      // Save to database
      const saved = await this.saveExecutivesToDatabase(
        siteId,
        companyUrl,
        companyInfo,
        executives,
      );

      return {
        success: true,
        companyUrl,
        companyName: companyInfo.name,
        executivesFound: executives.length,
        executivesSaved: saved,
      };
    } catch (error) {
      console.error(`❌ Error scraping company page: ${error.message}`);
      return {
        success: false,
        companyUrl,
        error: error.message,
      };
    }
  }

  /**
   * Post-process raw executives list to select structured roles:
   * - Up to 3 Founders (priority: founder > co-founder > owner)
   * - 1 CEO
   * - 1 CTO
   * Same person can appear in both founder and CEO/CTO slots.
   * @param {Array} allExecutives - Raw extracted executives
   * @returns {Array} - Filtered executives (max 5)
   */
  selectStructuredExecutives(allExecutives) {
    const selected = [];

    // 1. Select CEO (first match)
    const ceo = allExecutives.find((e) => e.roleCategory === "ceo");
    if (ceo) {
      selected.push(ceo);
      console.log(`   👔 CEO: ${ceo.name || "Unknown"}`);
    }

    // 2. Select CTO (first match)
    const cto = allExecutives.find((e) => e.roleCategory === "cto");
    if (cto) {
      selected.push(cto);
      console.log(`   💻 CTO: ${cto.name || "Unknown"}`);
    }

    // 3. Select up to 3 founders with priority: founder > co-founder > owner
    const founderPriority = ["founder", "co-founder", "owner"];
    const founders = [];

    for (const role of founderPriority) {
      if (founders.length >= 3) break;
      const matches = allExecutives.filter((e) => e.roleCategory === role);
      for (const match of matches) {
        if (founders.length >= 3) break;
        // Allow same person in both founder + CEO/CTO slots (don't deduplicate)
        founders.push(match);
        console.log(`   🏗️ Founder ${founders.length}: ${match.name || "Unknown"} (${match.roleCategory})`);
      }
    }

    // Add founders that aren't already selected (by profileUrl)
    for (const founder of founders) {
      const alreadyAdded = selected.some(
        (s) => s.profileUrl === founder.profileUrl
      );
      if (!alreadyAdded) {
        selected.push(founder);
      }
    }

    console.log(`   📊 Structure: ${founders.length} Founder(s), ${ceo ? 1 : 0} CEO, ${cto ? 1 : 0} CTO`);

    return selected;
  }

  /**
   * Extract basic company information
   */
  async extractCompanyInfo() {
    return await this.page.evaluate(() => {
      // Extract company name from multiple sources
      let name = "";

      // Try h1
      const h1 = document.querySelector("h1");
      if (h1) {
        name = h1.textContent.trim();
      }

      // Try title as fallback
      if (!name && document.title) {
        const titleParts = document.title.split("|");
        if (titleParts.length > 0) {
          name = titleParts[0].trim();
        }
      }

      // Extract follower count if available
      const followerElement = document.querySelector(
        '[data-anonymize="company-employees-count"]',
      );
      const followers = followerElement
        ? followerElement.textContent.trim()
        : "";

      // Extract industry
      const industryElement = document.querySelector(
        '[data-anonymize="company-industry"]',
      );
      const industry = industryElement
        ? industryElement.textContent.trim()
        : "";

      return {
        name,
        followers,
        industry,
      };
    });
  }

  /**
   * Extract executives (founders, co-founders, CEOs) from people page
   */
  async extractExecutives() {
    return await this.page.evaluate(() => {
      const executives = [];

      // Target keywords in headlines
      const targetKeywords = [
        "founder",
        "co-founder",
        "cofounder",
        "ceo",
        "chief executive officer",
        "cto",
        "chief technology officer",
        "owner",
        "president",
        "managing director",
        "md",
        "partner",
      ];

      // Debug: Log what we're finding
      console.log("[LinkedIn Scraper] Searching for executives...");

      // Method 1: Try multiple card selectors
      const cardSelectors = [
        ".org-people-profile-card__profile-info",
        ".pv5",
        ".entity-result__item",
        "li[data-urn]",
        '[data-urn*="person"]',
        ".ppl-list-header",
        ".artdeco-list__item",
      ];

      let allCards = [];
      for (const selector of cardSelectors) {
        const cards = document.querySelectorAll(selector);
        if (cards.length > 0) {
          console.log(
            `[LinkedIn Scraper] Found ${cards.length} cards with selector: ${selector}`,
          );
          allCards = Array.from(cards);
          break;
        }
      }

      // Method 2: If no cards found, look for ALL profile links
      if (allCards.length === 0) {
        console.log(
          "[LinkedIn Scraper] No cards found, looking for profile links...",
        );
        allCards = Array.from(document.querySelectorAll('a[href*="/in/"]'))
          .map((link) => link.closest("div, li, artdeco-entity"))
          .filter((el) => el !== null);
        console.log(
          `[LinkedIn Scraper] Found ${allCards.length} potential containers`,
        );
      }

      // Process each card/container
      allCards.forEach((card, index) => {
        try {
          // Get profile link - try multiple approaches
          let profileLink = card.querySelector('a[href*="/in/"]');

          // If not in card, look in nearby elements
          if (!profileLink) {
            const allLinks =
              card.parentElement?.querySelectorAll('a[href*="/in/"]') || [];
            profileLink = allLinks[0];
          }

          if (!profileLink) {
            console.log(
              `[LinkedIn Scraper] Card ${index}: No profile link found`,
            );
            return;
          }

          const profileUrl = profileLink.href.split("?")[0].split("#")[0];
          console.log(
            `[LinkedIn Scraper] Card ${index}: Found profile ${profileUrl}`,
          );

          // Get name - try multiple selectors
          let name = "";
          const nameSelectors = [
            '[data-anonymize="person-name"]',
            ".artdeco-entity-lockup__title",
            ".entity-result__title",
            'a[href*="/in/"]',
            ".text-heading-xlarge",
            "h1",
            "h2",
            "h3",
          ];

          for (const selector of nameSelectors) {
            const nameElement = card.querySelector(selector);
            if (
              nameElement &&
              nameElement.textContent &&
              nameElement.textContent.trim().length > 0
            ) {
              name = nameElement.textContent.trim();
              // If it's the link itself, it might just be "View profile", so check
              if (
                name.toLowerCase().includes("view") &&
                name.toLowerCase().includes("profile")
              ) {
                name = "";
                continue;
              }
              break;
            }
          }

          // Get headline/subtitle - try multiple selectors
          let headline = "";
          const headlineSelectors = [
            '[data-anonymize="person-role"]',
            ".artdeco-entity-lockup__subtitle",
            ".entity-result__summary",
            ".entity-result__content-sub",
            ".ppl-list-header__subtitle",
            ".text-body-medium",
          ];

          for (const selector of headlineSelectors) {
            const headlineElement = card.querySelector(selector);
            if (headlineElement && headlineElement.textContent) {
              headline = headlineElement.textContent.trim().toLowerCase();
              break;
            }
          }

          // Also try to get headline from text content around the profile link
          if (!headline) {
            const parent = profileLink.closest("div, li, artdeco-entity");
            if (parent) {
              const text = parent.textContent || "";
              headline = text.toLowerCase();
            }
          }

          console.log(
            `[LinkedIn Scraper] Card ${index}: Name="${name}", Headline="${headline}"`,
          );

          // Check if headline contains target keywords
          const hasTargetKeyword = targetKeywords.some((keyword) =>
            headline.includes(keyword.toLowerCase()),
          );

          if (hasTargetKeyword) {
            // Determine role category
            let roleCategory = "other";
            const fullHeadline = headline || "";

            if (
              fullHeadline.includes("co-founder") ||
              fullHeadline.includes("cofounder")
            ) {
              roleCategory = "co-founder";
            } else if (fullHeadline.includes("founder")) {
              roleCategory = "founder";
            } else if (
              fullHeadline.includes("ceo") ||
              fullHeadline.includes("chief executive")
            ) {
              roleCategory = "ceo";
            } else if (
              fullHeadline.includes("cto") ||
              fullHeadline.includes("chief technology")
            ) {
              roleCategory = "cto";
            } else if (fullHeadline.includes("president")) {
              roleCategory = "president";
            } else if (fullHeadline.includes("owner")) {
              roleCategory = "owner";
            } else if (
              fullHeadline.includes("managing director") ||
              fullHeadline.includes("md")
            ) {
              roleCategory = "md";
            } else if (fullHeadline.includes("partner")) {
              roleCategory = "partner";
            }

            executives.push({
              profileUrl,
              name: name || null,
              headline: headline || null,
              roleCategory,
            });

            console.log(
              `[LinkedIn Scraper] ✅ Added: ${name} (${roleCategory})`,
            );
          }
        } catch (e) {
          console.log(`[LinkedIn Scraper] Card ${index} error:`, e.message);
        }
      });

      console.log(
        `[LinkedIn Scraper] Total executives found: ${executives.length}`,
      );

      return executives;
    });
  }

  /**
   * Save executives to database
   */
  async saveExecutivesToDatabase(siteId, companyUrl, companyInfo, executives) {
    const db = require("./database");

    let savedCount = 0;

    for (const exec of executives) {
      const result = db.saveExecutive({
        site_id: siteId,
        company_url: companyUrl,
        company_name: companyInfo.name || null,
        profile_url: exec.profileUrl,
        name: exec.name || null,
        headline: exec.headline || null,
        role_category: exec.roleCategory || null,
      });

      if (result.success) {
        savedCount++;
        console.log(
          `   💾 Saved: ${exec.name || "Unknown"} (${exec.roleCategory || "Unknown"})`,
        );
      } else if (result.error === "Profile already exists") {
        console.log(`   ⊗ Already exists: ${exec.name || "Unknown"}`);
      } else {
        console.log(`   ⚠️  Error saving: ${result.error}`);
      }
    }

    return savedCount;
  }

  /**
   * Process all LinkedIn company URLs from the database
   */
  async processAllCompanyUrls() {
    const db = require("./database");
    const database = db.initDatabase();

    try {
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
        `\n📊 Found ${companyUrls.length} LinkedIn company URLs to process (skipping companies with existing executives)`,
      );

      if (companyUrls.length === 0) {
        console.log(`✅ All companies already have executives scraped!`);
        return [];
      }

      const results = [];

      for (let i = 0; i < companyUrls.length; i++) {
        const company = companyUrls[i];
        console.log(`\n${"=".repeat(70)}`);
        console.log(
          `[${i + 1}/${companyUrls.length}] Processing: ${company.linkedin_url}`,
        );
        console.log(`   From site: ${company.site_url}`);

        const result = await this.scrapeCompanyPage(
          company.linkedin_url,
          company.site_id,
        );
        results.push({
          ...result,
          siteUrl: company.site_url,
        });

        // Delay between companies
        if (i < companyUrls.length - 1) {
          const delay = randomDelay(5000, 8000);
          console.log(`⏱️  Waiting ${delay}ms before next company...`);
          await this.page.waitForTimeout(delay);
        }
      }

      // Summary
      console.log(`\n${"=".repeat(70)}`);
      console.log("📊 SUMMARY:");
      console.log(`   Total companies processed: ${companyUrls.length}`);
      console.log(`   Successful: ${results.filter((r) => r.success).length}`);
      console.log(`   Failed: ${results.filter((r) => !r.success).length}`);

      const totalExecutives = results
        .filter((r) => r.success)
        .reduce((sum, r) => sum + (r.executivesFound || 0), 0);

      console.log(`   Total executives found: ${totalExecutives}`);

      return results;
    } finally {
      database.close();
    }
  }
}

// Export functions
module.exports = {
  LinkedInCompanyScraper,
  scrapeCompanyUrls: async () => {
    const scraper = new LinkedInCompanyScraper();
    try {
      return await scraper.processAllCompanyUrls();
    } finally {
      await scraper.close();
    }
  },
};
