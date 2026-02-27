const { chromium } = require("playwright");
const db = require("./database");
const path = require("path");

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
 * Extract emails from text with advanced filtering
 * @param {string} text - Text content to search
 * @param {string} url - Source URL
 * @returns {Array} - Array of email objects {email, source}
 */
function extractEmails(text, url) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = new Set();
  let match;

  while ((match = emailRegex.exec(text)) !== null) {
    emails.add(match[0].toLowerCase());
  }

  // Convert to array and filter
  const results = Array.from(emails).filter((email) => {
    const [localPart, domain] = email.split("@");

    // Exclude common false positives
    const excludePatterns = [
      "example",
      "test",
      "sample",
      "your-email",
      "email@address",
      "noreply",
      "no-reply",
      "donotreply",
      "do-not-reply",
      "privacy",
      "terms",
      "legal",
      "abuse",
      "postmaster",
      "webmaster",
      "localhost",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".svg",
      ".css",
      ".js",
      ".woff",
      ".woff2",
      ".ttf",
      ".ico",
    ];

    for (const pattern of excludePatterns) {
      if (email.includes(pattern)) {
        return false;
      }
    }

    // Must have valid domain
    if (!domain || domain.includes(".") === false) {
      return false;
    }

    return true;
  });

  return results.map((email) => ({ email, source: url }));
}

/**
 * Check if email domain matches website domain
 * @param {string} email - The email address
 * @param {string} websiteUrl - The website URL
 * @returns {boolean} - True if domains match
 */
function isDomainMatch(email, websiteUrl) {
  try {
    const emailDomain = email.split("@")[1]?.toLowerCase();
    const urlDomain = new URL(websiteUrl).hostname.toLowerCase();

    if (!emailDomain) return false;

    // Remove www. prefix for comparison
    const cleanEmailDomain = emailDomain.replace(/^www\./, "");
    const cleanUrlDomain = urlDomain.replace(/^www\./, "");

    return cleanEmailDomain === cleanUrlDomain;
  } catch {
    return false;
  }
}

/**
 * Check if email is generic (info@, contact@, etc.)
 * @param {string} email - The email address
 * @returns {boolean} - True if generic
 */
function isGeneric(email) {
  const genericPrefixes = [
    "info",
    "contact",
    "hello",
    "mail",
    "admin",
    "support",
    "sales",
    "enquiry",
    "inquiry",
    "office",
    "team",
    "general",
  ];

  const localPart = email.split("@")[0]?.toLowerCase();
  return localPart && genericPrefixes.includes(localPart);
}

/**
 * Extract emails from text content (simplified version)
 * @param {string} content - HTML content to search
 * @returns {Array} - Array of unique email addresses
 */
function extractEmailsSimple(content) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const matches = content.match(emailRegex) || [];

  // Filter out common false positives
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
 * @param {string} content - HTML content to search
 * @returns {Array} - Array of unique phone numbers
 */
function extractPhones(content) {
  // Various phone number formats:
  // (123) 456-7890, 123-456-7890, 123.456.7890, 1234567890
  // +1 123 456 7890, +44 20 1234 5678, etc.
  const phoneRegexes = [
    /\+?\d{1,3}[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, // US/CA format
    /\+?\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g, // International
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // Simple 10-digit
  ];

  const allMatches = [];
  for (const regex of phoneRegexes) {
    const matches = content.match(regex) || [];
    allMatches.push(...matches);
  }

  // Filter out common false positives and return unique, cleaned
  const falsePositives = [
    /123[-.\s]?\d{3}[-.\s]?\d{4}/, // Example numbers
    /000[-.\s]?\d{3}[-.\s]?\d{4}/,
    /111[-.\s]?\d{3}[-.\s]?\d{4}/,
    /999[-.\s]?\d{3}[-.\s]?\d{4}/,
    /\d{10}/, // Raw 10-digit (too many false positives)
  ];

  const uniquePhones = [...new Set(allMatches)]
    .map((phone) => phone.replace(/[^\d+]/g, "").substring(0, 15)) // Clean to digits only
    .filter(
      (phone) =>
        phone.length >= 10 &&
        phone.length <= 15 &&
        !falsePositives.some((pattern) => pattern.test(phone)),
    );

  return uniquePhones;
}

/**
 * Extract LinkedIn profiles from text content
 * @param {string} content - HTML content to search
 * @returns {Array} - Array of unique LinkedIn profile URLs
 */
function extractLinkedinProfiles(content) {
  // LinkedIn URL patterns
  const linkedinRegexes = [
    /https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/gi, // Standard profile URLs
    /https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9_-]+/gi, // Company page URLs
    /https?:\/\/(?:www\.)?linkedin\.com\/pub\/[a-zA-Z0-9_-]+/gi, // Legacy profile URLs
    /https?:\/\/(?:www\.)?linkedin\.com\/profile\/view\?id=\d+/gi, // Old profile view URLs
    /href="([^"]*linkedin\.com\/in\/[^"]*)"/gi, // Extract from href attributes
    /href="([^"]*linkedin\.com\/company\/[^"]*)"/gi, // Extract company pages from href
  ];

  const allMatches = [];
  for (const regex of linkedinRegexes) {
    const matches = content.match(regex) || [];
    allMatches.push(...matches);
  }

  // Clean and normalize URLs
  const uniqueProfiles = [...new Set(allMatches)]
    .map((url) => {
      // Clean up the URL
      let cleanUrl = url.replace(/"/g, "").replace(/'/g, "").trim();

      // Ensure it starts with https
      if (!cleanUrl.startsWith("http")) {
        cleanUrl = "https://" + cleanUrl;
      }

      return cleanUrl;
    })
    .filter((url) => {
      // Filter out common false positives and invalid URLs
      const falsePositives = [
        /linkedin\.com\/feed/, // Feed pages
        /linkedin\.com\/jobs/, // Job pages
        /linkedin\.com\/learning/, // Learning pages
        /linkedin\.com\/messaging/, // Messaging
        /linkedin\.com\/settings/, // Settings
        /linkedin\.com\/help/, // Help pages
        /linkedin\.com\/pulse/, // Pulse articles
        /linkedin\.com\/groups/, // Groups
        /linkedin\.com\/in\/[a-zA-Z0-9_-]*\.(png|jpg|jpeg|gif|svg|ico)/, // Image files
        /linkedin\.com\/in\/[a-zA-Z0-9_-]*\?trk=/, // Tracking URLs
        /linkedin\.com\/in\/[a-zA-Z0-9_-]*\&trk=/, // Tracking URLs
      ];

      return (
        !falsePositives.some((pattern) => pattern.test(url)) &&
        (url.includes("/in/") || url.includes("/company/"))
      );
    });

  return uniqueProfiles;
}

/**
 * Checks if a URL is a WordPress site by looking for common WordPress paths
 * @param {Page} page - Playwright page object
 * @param {string} url - URL to check
 * @returns {Promise<Object>} - Detection results
 */
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

    // ========== CHECK 5: WordPress Cookies (WEAK - third-party cookies) ==========
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

    // ========== CHECK 5: HTML Content Indicators (Wappalyzer-style) ==========
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

    // ========== EXTRACT CONTENT FOR AI ENRICHMENT ==========
    try {
      // We extract text content BEFORE we decide if it's WordPress or not,
      // just in case we ever want to run AI on non-WordPress sites too.
      // We only extract up to ~2,000 characters to save AI tokens.

      const pageText = await page.evaluate(() => {
        // Clone body to avoid mutating the actual page
        const bodyClone = document.body.cloneNode(true);

        // Remove unwanted elements
        const unwantedSelectors = [
          "script",
          "style",
          "noscript",
          "iframe",
          "svg",
          "header",
          "footer",
          "nav",
          ".menu",
          "#menu",
        ];

        unwantedSelectors.forEach((selector) => {
          const elements = bodyClone.querySelectorAll(selector);
          elements.forEach((el) => el.remove());
        });

        // Get text and clean up whitespace
        let text = bodyClone.innerText || "";
        text = text.replace(/\s+/g, " ").trim();

        return text;
      });

      // Store up to 2,000 chars
      result.text_content = pageText.substring(0, 2000);
    } catch (e) {
      console.log(`      ⚠️  Could not extract text content: ${e.message}`);
      result.text_content = "";
    }

    // ========== CONTACT EXTRACTION (ONLY FOR WORDPRESS SITES) ==========
    if (result.isWordPress) {
      console.log(
        `      ✓ WordPress detected (score: ${result.confidenceScore}) - extracting contacts...`,
      );

      const allEmails = new Set();
      const allPhones = new Set();
      const allLinkedinProfiles = new Set();

      // Extract from homepage
      const homepageEmails = extractEmailsSimple(content);
      const homepagePhones = extractPhones(content);
      const homepageLinkedin = extractLinkedinProfiles(content);

      homepageEmails.forEach((email) => allEmails.add(email));
      homepagePhones.forEach((phone) => allPhones.add(phone));
      homepageLinkedin.forEach((profile) => allLinkedinProfiles.add(profile));

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

            const contactEmails = extractEmailsSimple(contactContent);
            const contactPhones = extractPhones(contactContent);
            const contactLinkedin = extractLinkedinProfiles(contactContent);

            contactEmails.forEach((email) => allEmails.add(email));
            contactPhones.forEach((phone) => allPhones.add(phone));
            contactLinkedin.forEach((profile) =>
              allLinkedinProfiles.add(profile),
            );
          }
        } catch (e) {
          console.log(`      ⚠️  Could not load contact page: ${e.message}`);
        }
      }

      result.emails = Array.from(allEmails);
      result.phones = Array.from(allPhones);
      result.linkedin_profiles = Array.from(allLinkedinProfiles);

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
        console.log(`      ✗ Not WordPress (score: 0) - no indicators found`);
      }
    }
  } catch (error) {
    result.error = error.message;
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
    await page.waitForLoadState("networkidle");

    // Deactivate monitoring after a short delay
    setTimeout(() => {
      networkMonitoringActive = false;
    }, 2000);
  } catch (error) {
    console.log(`  ⚠️  Network monitoring failed: ${error.message}`);
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

/**
 * Performs a Google search and returns the result URLs
 * @param {Page} page - Playwright page object
 * @param {string} query - Search query
 * @param {number} maxResults - Maximum number of results to retrieve
 * @returns {Promise<Array<string>>} - Array of URLs
 */
async function googleSearch(page, query, maxResults = 10) {
  console.log(`\n🔍 Searching Google for: "${query}"\n`);

  // Navigate to Google
  await page.goto("https://www.google.com", { waitUntil: "networkidle" });

  // Accept cookies if the dialog appears
  try {
    const acceptButton = await page.$(
      'button:has-text("Accept all"), button:has-text("I agree")',
    );
    if (acceptButton) {
      await acceptButton.click();
      await page.waitForTimeout(1000);
    }
  } catch (e) {
    // Ignore if no cookie dialog
  }

  // Type search query
  const searchBox = await page.$('textarea[name="q"], input[name="q"]');
  if (!searchBox) {
    throw new Error("Could not find Google search box");
  }

  await searchBox.fill(query);
  await searchBox.press("Enter");

  // Wait for results to load
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
    console.log(`  ⚠️  CAPTCHA detected! Please solve it in the browser.`);
    console.log(`  ⏳ Waiting 30 seconds for CAPTCHA to be solved...`);
    await page.waitForTimeout(30000);
  }

  // Extract URLs from multiple pages
  const urls = [];
  const seenUrls = new Set();
  let pageNum = 0;
  const maxPages = 5; // Scrape up to 5 pages of results

  while (pageNum < maxPages && urls.length < 100) {
    console.log(`  📄 Scraping Google page ${pageNum + 1}...`);

    // Extract URLs from current page
    const pageUrls = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll("div#search a[href]");

      for (const link of links) {
        const href = link.getAttribute("href");
        // Skip internal Google links and ads
        if (
          href &&
          !href.includes("google.") &&
          !href.startsWith("#") &&
          !href.startsWith("/url?q=")
        ) {
          // Clean up Google redirect URLs
          const cleanUrl = href.startsWith("/url?q=")
            ? new URLSearchParams(href.split("?")[1]).get("q")
            : href;

          if (cleanUrl && cleanUrl.startsWith("http")) {
            const urlWithoutHash = cleanUrl.split("#")[0];
            results.push(urlWithoutHash);
          }
        }
      }
      return results;
    });

    // Add new URLs (avoiding duplicates)
    for (const url of pageUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        urls.push(url);
      }
    }

    console.log(
      `  ✓ Page ${pageNum + 1}: Found ${pageUrls.length} URLs (Total: ${
        urls.length
      } unique)`,
    );

    // If we got very few results, wait a bit (Google might be rate limiting)
    if (pageUrls.length < 5 && pageNum === 0) {
      console.log(
        `  ⚠️  Low result count. Google might be rate limiting. Waiting 5 seconds...`,
      );
      await page.waitForTimeout(5000);
    }

    // Check if there's a "Next" button
    const nextButton = await page.$(
      'a#pnnext, a[aria-label="Next"], a[aria-label="More results"]',
    );

    if (!nextButton || pageNum >= maxPages - 1) {
      console.log(`  ✓ No more pages available or reached max pages`);
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

      await page.waitForSelector("div#search", { timeout: 15000 }).catch(() => {
        // Page loaded but #search element might not be present
      });
      pageNum++;
    } catch (e) {
      console.log(`  ⚠️  Could not navigate to next page: ${e.message}`);
      break;
    }
  }

  console.log(`\n✅ Total unique URLs found: ${urls.length}\n`);
  return urls;
}

/**
 * Main function to run the WordPress detection
 */
async function main() {
  const userDataDir = "C:\\automation_chrome";
  // Use persistent context to save cookies, login sessions, and local storage
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
  const page = await context.newPage();

  try {
    // Get search query from command line arguments or use default
    const searchQuery = process.argv[2] || "myntra coupon code";

    // Perform Google search
    const urls = await googleSearch(page, searchQuery, 10);

    if (urls.length === 0) {
      console.log("No URLs found to check.");
      return;
    }

    // Filter out URLs that already exist in the database
    console.log("Checking for existing URLs in database...");
    const existingUrls = db.getAllExistingUrls();

    // Track duplicates for logging
    const duplicates = [];
    const newUrls = urls.filter((url) => {
      const normalized = db.normalizeUrl(url);
      if (existingUrls.has(normalized)) {
        duplicates.push(url);
        return false;
      }
      return true;
    });

    if (newUrls.length === 0) {
      console.log("All URLs already exist in database. Nothing to scrape.");
      if (duplicates.length > 0) {
        console.log(
          `\nSkipped ${
            duplicates.length
          } duplicate URLs:\n  - ${duplicates.join("\n  - ")}`,
        );
      }
      return;
    }

    console.log(
      `Found ${urls.length} total URLs, ${newUrls.length} new to check, ${duplicates.length} already exist.\n`,
    );

    if (duplicates.length > 0) {
      console.log("Skipped duplicates:");
      duplicates.forEach((url) => console.log(`  ✓ ${url}`));
      console.log("");
    }

    console.log("Checking each site for WordPress...\n");
    console.log("═".repeat(80));

    const results = [];
    let wordpressCount = 0;

    // Check each URL for WordPress
    for (let i = 0; i < newUrls.length; i++) {
      const url = newUrls[i];
      console.log(`\n[${i + 1}/${newUrls.length}] Checking: ${url}`);

      const result = await checkWordPress(page, url);
      results.push(result);

      if (result.isWordPress) {
        wordpressCount++;
        console.log(`  ✅ WordPress Site!`);
        console.log(`  Indicators: ${result.indicators.join(", ")}`);

        // Show contact info
        if (result.emails.length > 0 || result.phones.length > 0) {
          console.log(
            `  📧 Contacts: ${result.emails.length} emails, ${result.phones.length} phones`,
          );
          if (result.emails.length > 0) {
            console.log(`     Emails: ${result.emails.join(", ")}`);
          }
          if (result.phones.length > 0) {
            console.log(`     Phones: ${result.phones.join(", ")}`);
          }
        }
      } else {
        console.log(`  ❌ Not WordPress or could not detect`);

        // Still show contacts even for non-WP sites
        if (result.emails.length > 0 || result.phones.length > 0) {
          console.log(
            `  📧 Contacts found: ${result.emails.length} emails, ${result.phones.length} phones`,
          );
        }
      }

      if (result.error) {
        console.log(`  ⚠️  Error: ${result.error}`);
      }
    }

    // Print summary
    console.log("\n\n" + "═".repeat(80));
    console.log("\n📊 SUMMARY\n");
    console.log(`Total sites checked: ${newUrls.length}`);
    console.log(
      `WordPress sites: ${wordpressCount} (${(
        (wordpressCount / newUrls.length) *
        100
      ).toFixed(1)}%)`,
    );
    console.log(
      `Non-WordPress sites: ${newUrls.length - wordpressCount} (${(
        ((newUrls.length - wordpressCount) / newUrls.length) *
        100
      ).toFixed(1)}%)`,
    );

    // Count total contacts
    const totalEmails = results.reduce(
      (sum, r) => sum + (r.emails?.length || 0),
      0,
    );
    const totalPhones = results.reduce(
      (sum, r) => sum + (r.phones?.length || 0),
      0,
    );
    console.log(
      `\n📧 Contacts Found: ${totalEmails} emails, ${totalPhones} phones`,
    );

    console.log("\n🔴 WordPress Sites:");
    results
      .filter((r) => r.isWordPress)
      .forEach((r) => {
        console.log(`  • ${r.url}`);
        console.log(`    Indicators: ${r.indicators.join(", ")}`);
        if (r.emails && r.emails.length > 0) {
          console.log(`    📧 Emails: ${r.emails.join(", ")}`);
        }
        if (r.phones && r.phones.length > 0) {
          console.log(`    📞 Phones: ${r.phones.join(", ")}`);
        }
      });

    console.log("\n⚪ Non-WordPress Sites:");
    results
      .filter((r) => !r.isWordPress)
      .forEach((r) => {
        console.log(`  • ${r.url}`);
      });

    console.log("\n" + "═".repeat(80));

    // Save results to database
    console.log("\n💾 Saving results to database...");
    const searchId = db.saveSearchResults(searchQuery, results);
    console.log(`✅ Results saved! Search ID: ${searchId}`);
    console.log(`📁 Database location: ${db.DB_PATH}`);
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await context.close();
  }
}

// Run the script
main().catch(console.error);
