const Database = require("better-sqlite3");
const path = require("path");

// Database file location
const DB_PATH = path.join(__dirname, "wordpress-detector.db");

// ============ SHARED PERSISTENT DB INSTANCE ============
// Used by email-senders-templates-api.js and email-queue-worker.js
// which call db.run(), db.all(), db.get() directly.
let _sharedDb = null;

function getSharedDb() {
  if (!_sharedDb || !_sharedDb.open) {
    _sharedDb = new Database(DB_PATH);
  }
  return _sharedDb;
}

// Low-level wrappers (sqlite3-style API expected by email modules)
function run(sql, params = []) {
  const db = getSharedDb();
  return db.prepare(sql).run(...params);
}

function all(sql, params = []) {
  const db = getSharedDb();
  return db.prepare(sql).all(...params);
}

function get(sql, params = []) {
  const db = getSharedDb();
  return db.prepare(sql).get(...params);
}

function prepare(sql) {
  const db = getSharedDb();
  return db.prepare(sql);
}

/**
 * Initialize the database and create tables if they don't exist
 */
function initDatabase() {
  const db = new Database(DB_PATH);

  // Create searches table to track each search run
  db.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      total_sites INTEGER NOT NULL,
      wordpress_count INTEGER NOT NULL,
      non_wordpress_count INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create sites table to store individual site checks
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      search_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      is_wordpress INTEGER NOT NULL,
      confidence_score INTEGER DEFAULT 0,
      indicators TEXT,
      error TEXT,
      search_query TEXT,
      emails TEXT,
      phones TEXT,
      text_content TEXT,
      ai_processed INTEGER DEFAULT 0,
      ai_status TEXT DEFAULT 'pending',
      classification TEXT,
      relevance_score INTEGER,
      tags TEXT,
      primary_language TEXT,
      value_proposition TEXT,
      ai_reasoning TEXT,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (search_id) REFERENCES searches(id)
    )
  `);

  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sites_search_id ON sites(search_id);
    CREATE INDEX IF NOT EXISTS idx_sites_is_wordpress ON sites(is_wordpress);
    CREATE INDEX IF NOT EXISTS idx_searches_created_at ON searches(created_at);
  `);

  // Migration: Add confidence_score column if it doesn't exist
  try {
    db.prepare(
      `ALTER TABLE sites ADD COLUMN confidence_score INTEGER DEFAULT 0`,
    ).run();
  } catch (e) {
    // Column already exists, ignore error
  }

  // Create keywords table
  db.exec(`
    CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'pending',
      max_sites INTEGER DEFAULT 20,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(status);
  `);

  // Migration: Add max_sites to keywords
  try {
    db.exec(`ALTER TABLE keywords ADD COLUMN max_sites INTEGER DEFAULT 20`);
  } catch (e) {
    /* Ignore */
  }

  // Create contacts table (replaces emails/phones columns in sites table)
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      source_page TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_site_id ON contacts(site_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(type);
    CREATE INDEX IF NOT EXISTS idx_contacts_value ON contacts(value);
  `);

  // Create company_executives table for storing LinkedIn company executives
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_executives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL,
      company_url TEXT NOT NULL,
      company_name TEXT,
      profile_url TEXT NOT NULL UNIQUE,
      name TEXT,
      headline TEXT,
      role_category TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_company_executives_site_id ON company_executives(site_id);
    CREATE INDEX IF NOT EXISTS idx_company_executives_company_url ON company_executives(company_url);
    CREATE INDEX IF NOT EXISTS idx_company_executives_role_category ON company_executives(role_category);
    CREATE INDEX IF NOT EXISTS idx_company_executives_profile_url ON company_executives(profile_url);
  `);

  // Add LinkedIn type to existing contacts if it doesn't exist
  try {
    db.exec(`INSERT OR IGNORE INTO contacts (site_id, type, value, source_page) 
             SELECT id, 'linkedin', '', '' FROM sites WHERE 0=1`);
  } catch (e) {
    // Ignore if table structure doesn't match
  }

  // Migration: Add emails and phones columns if they don't exist (for backwards compatibility)
  try {
    db.exec(`ALTER TABLE sites ADD COLUMN emails TEXT`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE sites ADD COLUMN phones TEXT`);
  } catch (e) {
    // Column already exists
  }

  // Migrations for AI enrichment columns
  const aiColumns = [
    { name: "text_content", type: "TEXT" },
    { name: "ai_processed", type: "INTEGER DEFAULT 0" },
    { name: "ai_status", type: "TEXT DEFAULT 'pending'" },
    { name: "classification", type: "TEXT" },
    { name: "relevance_score", type: "INTEGER" },
    { name: "tags", type: "TEXT" },
    { name: "primary_language", type: "TEXT" },
    { name: "value_proposition", type: "TEXT" },
    { name: "ai_reasoning", type: "TEXT" },
    { name: "ai_is_wordpress", type: "INTEGER DEFAULT NULL" },
    { name: "ai_is_genuine_match", type: "INTEGER DEFAULT NULL" },
  ];

  for (const col of aiColumns) {
    try {
      db.exec(`ALTER TABLE sites ADD COLUMN ${col.name} ${col.type}`);
    } catch (e) {
      // Column already exists
    }
  }

  // Migration: Cleanup legacy records that have no text_content
  try {
    db.exec(`
      UPDATE sites 
      SET ai_processed = 1, 
          ai_status = 'failed', 
          ai_reasoning = 'No text content extracted during previous scrape.'
      WHERE is_wordpress = 1 
        AND (text_content IS NULL OR text_content = '') 
        AND (ai_processed = 0 OR ai_processed IS NULL)
    `);
  } catch (e) {
    // Ignore errors during migration
  }

  // Migration: Reprocess sites that failed previously but DO have text content (e.g. API Quota Errors)
  try {
    db.exec(`
      UPDATE sites 
      SET ai_processed = 0, 
          ai_status = 'pending',
          ai_reasoning = NULL
      WHERE is_wordpress = 1 
        AND text_content IS NOT NULL 
        AND text_content != ''
        AND ai_status = 'failed'
        AND (ai_reasoning IS NULL OR ai_reasoning != 'No text content extracted during previous scrape.')
    `);
  } catch (e) {
    // Ignore errors during migration
  }

  return db;
}

/**
 * Save search results to database
 * @param {string} query - Search query used
 * @param {Array} results - Array of site check results
 * @returns {number} - The search ID
 */
function saveSearchResults(query, results) {
  const db = initDatabase();

  const wordpressCount = results.filter((r) => r.isWordPress).length;
  const nonWordpressCount = results.length - wordpressCount;

  // Insert search record
  const insertSearch = db.prepare(`
    INSERT INTO searches (query, total_sites, wordpress_count, non_wordpress_count)
    VALUES (?, ?, ?, ?)
  `);

  const searchResult = insertSearch.run(
    query,
    results.length,
    wordpressCount,
    nonWordpressCount,
  );
  const searchId = searchResult.lastInsertRowid;

  // Insert site records
  const insertSite = db.prepare(`
    INSERT INTO sites (search_id, url, is_wordpress, confidence_score, indicators, error, search_query, text_content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertContact = db.prepare(`
    INSERT INTO contacts (site_id, type, value, source_page)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db.transaction((sites) => {
    for (const site of sites) {
      const siteResult = insertSite.run(
        searchId,
        site.url,
        site.isWordPress ? 1 : 0,
        site.confidenceScore || 0,
        site.indicators.join(", "),
        site.error || null,
        query,
        site.text_content || null,
      );

      // Get the site ID that was just inserted
      const siteId = siteResult.lastInsertRowid;

      // Insert emails
      if (site.emails && site.emails.length > 0) {
        for (const email of site.emails) {
          insertContact.run(siteId, "email", email, site.url);
        }
      }

      // Insert phones
      if (site.phones && site.phones.length > 0) {
        for (const phone of site.phones) {
          insertContact.run(siteId, "phone", phone, site.url);
        }
      }

      // Insert LinkedIn profiles
      if (site.linkedin_profiles && site.linkedin_profiles.length > 0) {
        for (const linkedin of site.linkedin_profiles) {
          insertContact.run(siteId, "linkedin", linkedin, site.url);
        }
      }
    }
  });

  insertMany(results);

  db.close();
  return searchId;
}

/**
 * Get all searches
 * @returns {Array} - Array of searches
 */
function getAllSearches() {
  const db = initDatabase();
  const searches = db
    .prepare(
      `
    SELECT
      id,
      query,
      total_sites,
      wordpress_count,
      non_wordpress_count,
      created_at
    FROM searches
    ORDER BY created_at DESC
  `,
    )
    .all();

  db.close();
  return searches;
}

/**
 * Get search by ID with all sites
 * @param {number} searchId - Search ID
 * @returns {Object} - Search with sites
 */
function getSearchById(searchId) {
  const db = initDatabase();

  const search = db
    .prepare(
      `
    SELECT * FROM searches WHERE id = ?
  `,
    )
    .get(searchId);

  if (!search) {
    db.close();
    return null;
  }

  const sites = db
    .prepare(
      `
    SELECT * FROM sites WHERE search_id = ?
  `,
    )
    .all(searchId);

  db.close();

  return {
    ...search,
    sites,
  };
}

/**
 * Get all WordPress sites across all searches
 * @returns {Array} - WordPress sites
 */
function getAllWordpressSites() {
  const db = initDatabase();

  const sites = db
    .prepare(
      `
    SELECT
      s.*,
      sc.query as search_query,
      sc.created_at as search_date
    FROM sites s
    JOIN searches sc ON s.search_id = sc.id
    WHERE s.is_wordpress = 1
    ORDER BY s.checked_at DESC
  `,
    )
    .all();

  db.close();
  return sites;
}

/**
 * Get statistics
 * @returns {Object} - Statistics
 */
function getStatistics() {
  const db = initDatabase();

  const stats = db
    .prepare(
      `
    SELECT
      COUNT(DISTINCT id) as total_searches,
      SUM(total_sites) as total_sites_checked,
      SUM(wordpress_count) as total_wordpress_sites,
      SUM(non_wordpress_count) as total_non_wordpress_sites
    FROM searches
  `,
    )
    .get();

  const topQueries = db
    .prepare(
      `
    SELECT
      query,
      COUNT(*) as search_count,
      SUM(wordpress_count) as wordpress_found
    FROM searches
    GROUP BY query
    ORDER BY search_count DESC
    LIMIT 10
  `,
    )
    .all();

  db.close();

  return {
    ...stats,
    topQueries,
  };
}

/**
 * Export database to JSON
 * @param {string} outputPath - Output file path
 */
function exportToJSON(outputPath) {
  const db = initDatabase();

  const searches = db
    .prepare(
      `
    SELECT * FROM searches ORDER BY created_at DESC
  `,
    )
    .all();

  const data = searches.map((search) => {
    const sites = db
      .prepare(
        `
      SELECT * FROM sites WHERE search_id = ?
    `,
      )
      .all(search.id);

    return {
      ...search,
      sites,
    };
  });

  const fs = require("fs");
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));

  db.close();
  console.log(`\n✅ Data exported to ${outputPath}`);
}

// ============ KEYWORD CRUD OPERATIONS ============

/**
 * Get all keywords
 * @returns {Array} - Array of keywords
 */
function getAllKeywords() {
  const db = initDatabase();
  const keywords = db
    .prepare(
      `
    SELECT * FROM keywords ORDER BY created_at DESC
  `,
    )
    .all();
  db.close();
  return keywords;
}

/**
 * Get keyword by ID
 * @param {number} id - Keyword ID
 * @returns {Object} - Keyword
 */
function getKeywordById(id) {
  const db = initDatabase();
  const keyword = db
    .prepare(
      `
    SELECT * FROM keywords WHERE id = ?
  `,
    )
    .get(id);
  db.close();
  return keyword;
}

/**
 * Add a new keyword
 * @param {string} keyword - Keyword to add
 * @param {number} maxSites - Maximum sites to scrape (default 20)
 * @returns {Object} - Created keyword
 */
function addKeyword(keyword, maxSites = 20) {
  const db = initDatabase();
  const result = db
    .prepare(
      `
    INSERT INTO keywords (keyword, status, max_sites)
    VALUES (?, 'pending', ?)
  `,
    )
    .run(keyword.trim(), maxSites);

  const created = getKeywordById(result.lastInsertRowid);
  db.close();
  return created;
}

/**
 * Update keyword
 * @param {number} id - Keyword ID
 * @param {string} keyword - New keyword value
 * @returns {Object} - Updated keyword
 */
function updateKeyword(id, keyword) {
  const db = initDatabase();
  db.prepare(
    `
    UPDATE keywords
    SET keyword = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(keyword.trim(), id);
  db.close();
  return getKeywordById(id);
}

/**
 * Delete keyword
 * @param {number} id - Keyword ID
 * @returns {boolean} - Success
 */
function deleteKeyword(id) {
  const db = initDatabase();
  const result = db
    .prepare(
      `
    DELETE FROM keywords WHERE id = ?
  `,
    )
    .run(id);
  db.close();
  return result.changes > 0;
}

/**
 * Update keyword status
 * @param {number} id - Keyword ID
 * @param {string} status - New status
 * @returns {Object} - Updated keyword
 */
function updateKeywordStatus(id, status) {
  const db = initDatabase();
  db.prepare(
    `
    UPDATE keywords
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(status, id);
  db.close();
  return getKeywordById(id);
}

/**
 * Get sites by WordPress status with pagination
 * @param {boolean} isWordPress - Filter by WordPress status
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @param {string} searchQuery - Optional search filter
 * @returns {Object} - Sites with pagination info
 */
function getSitesByWordpressStatus(
  isWordPress,
  page = 1,
  limit = 50,
  searchQuery = null,
) {
  const db = initDatabase();
  const offset = (page - 1) * limit;

  let sites;
  let countResult;

  if (searchQuery && searchQuery.trim() !== "") {
    sites = db
      .prepare(
        `
      SELECT
        id,
        url,
        is_wordpress,
        confidence_score,
        indicators,
        error,
        search_query,
        emails,
        phones,
        ai_status,
        classification,
        relevance_score,
        tags,
        primary_language,
        value_proposition,
        ai_reasoning,
        ai_verified_wp,
        ai_wp_confidence,
        ai_wp_indicators,
        ai_content_relevant,
        ai_actual_category,
        ai_content_summary,
        ai_mismatch_reason,
        checked_at
      FROM sites
      WHERE is_wordpress = ? AND (url LIKE ? OR search_query LIKE ?)
      ORDER BY checked_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(
        isWordPress ? 1 : 0,
        `%${searchQuery}%`,
        `%${searchQuery}%`,
        limit,
        offset,
      );

    countResult = db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM sites
      WHERE is_wordpress = ? AND (url LIKE ? OR search_query LIKE ?)
    `,
      )
      .get(isWordPress ? 1 : 0, `%${searchQuery}%`, `%${searchQuery}%`);
  } else {
    sites = db
      .prepare(
        `
      SELECT
        id,
        url,
        is_wordpress,
        confidence_score,
        indicators,
        error,
        search_query,
        emails,
        phones,
        ai_status,
        classification,
        relevance_score,
        tags,
        primary_language,
        value_proposition,
        ai_reasoning,
        ai_verified_wp,
        ai_wp_confidence,
        ai_wp_indicators,
        ai_content_relevant,
        ai_actual_category,
        ai_content_summary,
        ai_mismatch_reason,
        checked_at
      FROM sites
      WHERE is_wordpress = ?
      ORDER BY checked_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(isWordPress ? 1 : 0, limit, offset);

    countResult = db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM sites
      WHERE is_wordpress = ?
    `,
      )
      .get(isWordPress ? 1 : 0);
  }

  db.close();

  return {
    sites,
    pagination: {
      page,
      limit,
      total: countResult.total,
      totalPages: Math.ceil(countResult.total / limit),
    },
  };
}

/**
 * Get all sites with pagination
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @param {string} searchQuery - Optional search filter
 * @param {string} filter - Filter type
 * @param {string} category - Category filter
 * @returns {Object} - Sites with pagination info
 */
function getAllSites(page = 1, limit = 50, searchQuery = null, filter = "all", category = null) {
  const db = initDatabase();
  const offset = (page - 1) * limit;

  let whereClauses = [];
  let params = [];

  if (searchQuery && searchQuery.trim() !== "") {
    whereClauses.push("(url LIKE ? OR search_query LIKE ?)");
    params.push(`%${searchQuery}%`, `%${searchQuery}%`);
  }

  if (filter === "wordpress") whereClauses.push("is_wordpress = 1");
  else if (filter === "non-wordpress") whereClauses.push("is_wordpress = 0");
  else if (filter === "verified-wp") whereClauses.push("ai_verified_wp = 1");
  else if (filter === "not-wp") whereClauses.push("ai_verified_wp = 0");
  else if (filter === "content-relevant") whereClauses.push("ai_content_relevant = 1");
  else if (filter === "content-mismatch") whereClauses.push("ai_content_relevant = 0");
  else if (filter === "ai-pending") whereClauses.push("is_wordpress = 1 AND (ai_status = 'pending' OR ai_status IS NULL)");

  // Category filter
  if (category && category !== "all") {
    whereClauses.push("ai_actual_category = ?");
    params.push(category);
  }

  const whereSql =
    whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const sites = db
    .prepare(
      `
    SELECT
      id, url, is_wordpress, confidence_score, indicators, error,
      search_query, emails, phones, ai_status, classification,
      relevance_score, tags, primary_language, value_proposition,
      ai_reasoning, ai_verified_wp, ai_wp_confidence, ai_wp_indicators,
      ai_content_relevant, ai_actual_category, ai_content_summary,
      ai_mismatch_reason, checked_at
    FROM sites
    ${whereSql}
    ORDER BY checked_at DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(...params, limit, offset);

  const countResult = db
    .prepare(
      `
    SELECT COUNT(*) as total
    FROM sites
    ${whereSql}
  `,
    )
    .get(...params);

  db.close();

  return {
    sites,
    pagination: {
      page,
      limit,
      total: countResult.total,
      totalPages: Math.ceil(countResult.total / limit),
    },
  };
}

// ============ AI ENRICHMENT OPERATIONS ============

/**
 * Get distinct AI categories
 * @returns {Array} - Array of unique category strings
 */
function getDistinctCategories() {
  const db = initDatabase();
  try {
    const rows = db.prepare(`
      SELECT DISTINCT ai_actual_category 
      FROM sites 
      WHERE ai_actual_category IS NOT NULL AND ai_actual_category != ''
      ORDER BY ai_actual_category ASC
    `).all();
    return rows.map(r => r.ai_actual_category);
  } finally {
    db.close();
  }
}

/**
 * Get sites that are pending AI enrichment
 * @param {number} limit - Maximum number of sites to return
 * @returns {Array} - Array of sites needing AI processing
 */
function getPendingAISites(limit = 10) {
  const db = initDatabase();
  const sites = db
    .prepare(
      `
    SELECT id, url, text_content, search_query
    FROM sites
    WHERE ai_status = 'pending' AND text_content IS NOT NULL AND text_content != ''
    ORDER BY checked_at DESC
    LIMIT ?
  `,
    )
    .all(limit);

  db.close();
  return sites;
}

/**
 * Update a site with AI classification results
 * @param {number} siteId - The ID of the site
 * @param {Object} aiData - The structured AI response
 * @returns {boolean} - True if successful
 */
function updateSiteAIResults(siteId, aiData) {
  const db = initDatabase();

  try {
    const result = db
      .prepare(
        `
      UPDATE sites 
      SET 
        ai_status = 'completed',
        classification = ?,
        relevance_score = ?,
        tags = ?,
        primary_language = ?,
        value_proposition = ?,
        ai_reasoning = ?,
        ai_is_wordpress = ?,
        ai_is_genuine_match = ?
      WHERE id = ?
    `,
      )
      .run(
        aiData.classification || null,
        aiData.relevanceScore || 0,
        aiData.tags ? JSON.stringify(aiData.tags) : null,
        aiData.primaryLanguage || null,
        aiData.valueProposition || null,
        aiData.reasoning || null,
        aiData.isLikelyWordPress === true
          ? 1
          : aiData.isLikelyWordPress === false
          ? 0
          : null,
        aiData.isGenuineMatch === true
          ? 1
          : aiData.isGenuineMatch === false
          ? 0
          : null,
        siteId,
      );

    db.close();
    return result.changes > 0;
  } catch (error) {
    db.close();
    console.error(`Error updating AI results for site ${siteId}:`, error);
    return false;
  }
}

/**
 * Mark a site's AI status as failed or skipped
 * @param {number} siteId - The ID of the site
 * @param {string} status - 'failed' or 'skipped'
 */
function updateSiteAIStatus(siteId, status) {
  const db = initDatabase();
  db.prepare(`UPDATE sites SET ai_status = ? WHERE id = ?`).run(status, siteId);
  db.close();
}

/**
 * Get emails with pagination and site info
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @param {string} search - Optional search filter
 * @returns {Object} - Emails with pagination
 */
function getEmails(page = 1, limit = 50, search = null) {
  const db = initDatabase();
  const offset = (page - 1) * limit;

  let emails;
  let countResult;

  if (search && search.trim() !== "") {
    emails = db
      .prepare(
        `
      SELECT
        c.id,
        c.value as email,
        c.source_page,
        c.created_at,
        s.url as site_url,
        s.is_wordpress,
        s.search_query
      FROM contacts c
      INNER JOIN sites s ON c.site_id = s.id
      WHERE c.type = 'email' AND c.value LIKE ?
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(`%${search}%`, limit, offset);

    countResult = db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM contacts c
      WHERE c.type = 'email' AND c.value LIKE ?
    `,
      )
      .get(`%${search}%`);
  } else {
    emails = db
      .prepare(
        `
      SELECT
        c.id,
        c.value as email,
        c.source_page,
        c.created_at,
        s.url as site_url,
        s.is_wordpress,
        s.search_query
      FROM contacts c
      INNER JOIN sites s ON c.site_id = s.id
      WHERE c.type = 'email'
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(limit, offset);

    countResult = db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM contacts
      WHERE type = 'email'
    `,
      )
      .get();
  }

  db.close();

  return {
    emails,
    pagination: {
      page,
      limit,
      total: countResult.total,
      totalPages: Math.ceil(countResult.total / limit),
    },
  };
}

/**
 * Get phones with pagination and site info
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @param {string} search - Optional search filter
 * @returns {Object} - Phones with pagination
 */
function getPhones(page = 1, limit = 50, search = null) {
  const db = initDatabase();
  const offset = (page - 1) * limit;

  let phones;
  let countResult;

  if (search && search.trim() !== "") {
    phones = db
      .prepare(
        `
      SELECT
        c.id,
        c.value as phone,
        c.source_page,
        c.created_at,
        s.url as site_url,
        s.is_wordpress,
        s.search_query
      FROM contacts c
      INNER JOIN sites s ON c.site_id = s.id
      WHERE c.type = 'phone' AND c.value LIKE ?
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(`%${search}%`, limit, offset);

    countResult = db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM contacts c
      WHERE c.type = 'phone' AND c.value LIKE ?
    `,
      )
      .get(`%${search}%`);
  } else {
    phones = db
      .prepare(
        `
      SELECT
        c.id,
        c.value as phone,
        c.source_page,
        c.created_at,
        s.url as site_url,
        s.is_wordpress,
        s.search_query
      FROM contacts c
      INNER JOIN sites s ON c.site_id = s.id
      WHERE c.type = 'phone'
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(limit, offset);

    countResult = db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM contacts
      WHERE type = 'phone'
    `,
      )
      .get();
  }

  db.close();

  return {
    phones,
    pagination: {
      page,
      limit,
      total: countResult.total,
      totalPages: Math.ceil(countResult.total / limit),
    },
  };
}

/**
 * Normalize URL for duplicate detection
 * @param {string} url - URL to normalize
 * @returns {string} - Normalized URL
 */
function normalizeUrl(url) {
  try {
    let normalized = url.toLowerCase().trim();

    // Remove protocol
    normalized = normalized.replace(/^https?:\/\//, "");

    // Remove www
    normalized = normalized.replace(/^www\./, "");

    // Remove trailing slash
    normalized = normalized.replace(/\/$/, "");

    // Remove hash fragments
    normalized = normalized.split("#")[0];

    // Remove query parameters (optional, can be kept if needed)
    // normalized = normalized.split('?')[0];

    return normalized;
  } catch (e) {
    return url;
  }
}

/**
 * Check if a URL already exists in the database
 * @param {string} url - URL to check
 * @returns {boolean} - True if URL exists
 */
function urlExists(url) {
  const db = initDatabase();
  const normalized = normalizeUrl(url);

  const result = db
    .prepare(
      `
    SELECT url FROM sites
  `,
    )
    .all();

  db.close();

  // Check if any normalized URL matches
  return result.some((site) => normalizeUrl(site.url) === normalized);
}

/**
 * Get all existing URLs from the database (normalized)
 * @returns {Set} - Set of all normalized URLs
 */
function getAllExistingUrls() {
  const db = initDatabase();
  const urls = db
    .prepare(
      `
    SELECT url FROM sites
  `,
    )
    .all();
  db.close();

  // Return a Set of normalized URLs for fast lookup
  const normalizedSet = new Set();
  urls.forEach((u) => {
    normalizedSet.add(normalizeUrl(u.url));
  });

  return normalizedSet;
}

/**
 * Get all contacts with filtering
 * @param {string} type - 'email', 'phone', 'linkedin', or 'all'
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @param {string} search - Optional search filter
 * @returns {Object} - Contacts with pagination
 */
function getAllContacts(type = "all", page = 1, limit = 50, search = null) {
  const db = initDatabase();
  const offset = (page - 1) * limit;

  let contacts;
  let countResult;
  let whereClause = "1=1";
  const params = [];

  if (type !== "all") {
    whereClause = "c.type = ?";
    params.push(type);
  }

  if (search && search.trim() !== "") {
    whereClause += (type !== "all" ? " AND " : "WHERE ") + "c.value LIKE ?";
    params.push(`%${search}%`);
  }

  contacts = db
    .prepare(
      `
    SELECT
      c.id,
      c.type,
      c.value,
      c.source_page,
      c.created_at,
      s.url as site_url,
      s.is_wordpress,
      s.search_query
    FROM contacts c
    INNER JOIN sites s ON c.site_id = s.id
    WHERE ${whereClause}
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(...params, limit, offset);

  // Count query
  const countParams = [...params];
  countResult = db
    .prepare(
      `
    SELECT COUNT(*) as total
    FROM contacts c
    INNER JOIN sites s ON c.site_id = s.id
    WHERE ${whereClause}
  `,
    )
    .get(...countParams);

  db.close();

  return {
    contacts,
    pagination: {
      page,
      limit,
      total: countResult.total,
      totalPages: Math.ceil(countResult.total / limit),
    },
  };
}

/**
 * Get LinkedIn profiles with pagination and site info
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @param {string} search - Optional search filter
 * @returns {Object} - LinkedIn profiles with pagination
 */
function getLinkedinProfiles(page = 1, limit = 50, search = null) {
  const db = initDatabase();
  const offset = (page - 1) * limit;

  let profiles;
  let countResult;

  if (search && search.trim() !== "") {
    profiles = db
      .prepare(
        `
      SELECT
        c.id,
        c.value as linkedin_url,
        c.source_page,
        c.created_at,
        s.url as site_url,
        s.is_wordpress,
        s.search_query
      FROM contacts c
      INNER JOIN sites s ON c.site_id = s.id
      WHERE c.type = 'linkedin' AND c.value LIKE ?
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(`%${search}%`, limit, offset);

    countResult = db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM contacts c
      WHERE c.type = 'linkedin' AND c.value LIKE ?
    `,
      )
      .get(`%${search}%`);
  } else {
    profiles = db
      .prepare(
        `
      SELECT
        c.id,
        c.value as linkedin_url,
        c.source_page,
        c.created_at,
        s.url as site_url,
        s.is_wordpress,
        s.search_query
      FROM contacts c
      INNER JOIN sites s ON c.site_id = s.id
      WHERE c.type = 'linkedin'
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `,
      )
      .all(limit, offset);

    countResult = db
      .prepare(
        `
      SELECT COUNT(*) as total
      FROM contacts
      WHERE type = 'linkedin'
    `,
      )
      .get();
  }

  db.close();

  return {
    linkedin_profiles: profiles,
    pagination: {
      page,
      limit,
      total: countResult.total,
      totalPages: Math.ceil(countResult.total / limit),
    },
  };
}

/**
 * Get enhanced contact statistics including LinkedIn
 * @returns {Object} - Enhanced contact stats
 */
function getContactStats() {
  const db = initDatabase();

  const stats = db
    .prepare(
      `
    SELECT
      (SELECT COUNT(*) FROM contacts WHERE type = 'email') as total_emails,
      (SELECT COUNT(*) FROM contacts WHERE type = 'phone') as total_phones,
      (SELECT COUNT(*) FROM contacts WHERE type = 'linkedin') as total_linkedin,
      (SELECT COUNT(DISTINCT site_id) FROM contacts WHERE type = 'email') as sites_with_emails,
      (SELECT COUNT(DISTINCT site_id) FROM contacts WHERE type = 'phone') as sites_with_phones,
      (SELECT COUNT(DISTINCT site_id) FROM contacts WHERE type = 'linkedin') as sites_with_linkedin
  `,
    )
    .get();

  db.close();
  return stats;
}

// ============ COMPANY EXECUTIVES OPERATIONS ============

/**
 * Save company executive to database
 * @param {Object} executive - Executive data
 * @returns {Object} - Saved executive
 */
function saveExecutive(executive) {
  const db = initDatabase();

  try {
    const result = db
      .prepare(
        `
      INSERT INTO company_executives (
        site_id,
        company_url,
        company_name,
        profile_url,
        name,
        headline,
        role_category
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        executive.site_id,
        executive.company_url,
        executive.company_name || null,
        executive.profile_url,
        executive.name || null,
        executive.headline || null,
        executive.role_category || null,
      );

    db.close();
    return { success: true, id: result.lastInsertRowid };
  } catch (err) {
    db.close();
    if (err.message.includes("UNIQUE")) {
      return { success: false, error: "Profile already exists" };
    }
    return { success: false, error: err.message };
  }
}

/**
 * Get all company executives with pagination
 * @param {number} page - Page number
 * @param {number} limit - Items per page
 * @param {string} search - Optional search filter
 * @param {string} roleCategory - Optional role category filter
 * @returns {Object} - Executives with pagination
 */
function getCompanyExecutives(
  page = 1,
  limit = 50,
  search = null,
  roleCategory = null,
) {
  const db = initDatabase();
  const offset = (page - 1) * limit;

  let executives;
  let countResult;
  let whereClause = "1=1";
  const params = [];

  if (roleCategory && roleCategory !== "all") {
    whereClause = "ce.role_category = ?";
    params.push(roleCategory);
  }

  if (search && search.trim() !== "") {
    whereClause +=
      (roleCategory && roleCategory !== "all" ? " AND " : "WHERE ") +
      "(ce.name LIKE ? OR ce.company_name LIKE ? OR ce.headline LIKE ?)";
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  executives = db
    .prepare(
      `
    SELECT
      ce.id,
      ce.company_url,
      ce.company_name,
      ce.profile_url,
      ce.name,
      ce.headline,
      ce.role_category,
      ce.created_at,
      s.url as site_url
    FROM company_executives ce
    INNER JOIN sites s ON ce.site_id = s.id
    WHERE ${whereClause}
    ORDER BY ce.created_at DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(...params, limit, offset);

  // Count query
  const countParams = [...params];
  countResult = db
    .prepare(
      `
    SELECT COUNT(*) as total
    FROM company_executives ce
    INNER JOIN sites s ON ce.site_id = s.id
    WHERE ${whereClause}
  `,
    )
    .get(...countParams);

  db.close();

  return {
    executives,
    pagination: {
      page,
      limit,
      total: countResult.total,
      totalPages: Math.ceil(countResult.total / limit),
    },
  };
}

/**
 * Get executives statistics
 * @returns {Object} - Statistics
 */
function getExecutivesStats() {
  const db = initDatabase();

  const stats = db
    .prepare(
      `
    SELECT
      COUNT(*) as total_executives,
      COUNT(DISTINCT company_url) as total_companies,
      COUNT(DISTINCT site_id) as total_sites,
      SUM(CASE WHEN role_category = 'founder' THEN 1 ELSE 0 END) as founders,
      SUM(CASE WHEN role_category = 'co-founder' THEN 1 ELSE 0 END) as co_founders,
      SUM(CASE WHEN role_category = 'ceo' THEN 1 ELSE 0 END) as ceos,
      SUM(CASE WHEN role_category = 'president' THEN 1 ELSE 0 END) as presidents,
      SUM(CASE WHEN role_category = 'owner' THEN 1 ELSE 0 END) as owners
    FROM company_executives
  `,
    )
    .get();

  db.close();
  return stats;
}

/**
 * Get executives by company URL
 * @param {string} companyUrl - LinkedIn company URL
 * @returns {Array} - Array of executives
 */
function getExecutivesByCompany(companyUrl) {
  const db = initDatabase();

  const executives = db
    .prepare(
      `
    SELECT * FROM company_executives
    WHERE company_url = ?
    ORDER BY role_category, name
  `,
    )
    .all(companyUrl);

  db.close();
  return executives;
}

// ============ AI ENRICHMENT ============

/**
 * Update a site with AI enrichment results
 * @param {number} siteId - ID of the site
 * @param {Object} aiData - The parsed JSON data from OpenAI
 * @returns {boolean} - True if successful
 */
function updateSiteAIResults(siteId, aiData) {
  const db = initDatabase();

  const result = db
    .prepare(
      `
    UPDATE sites 
    SET 
      ai_processed = 1,
      ai_status = 'completed',
      classification = ?,
      relevance_score = ?,
      tags = ?,
      primary_language = ?,
      value_proposition = ?,
      ai_reasoning = ?
    WHERE id = ?
  `,
    )
    .run(
      aiData.classification || null,
      aiData.relevanceScore || 0,
      aiData.tags ? JSON.stringify(aiData.tags) : null,
      aiData.primaryLanguage || null,
      aiData.valueProposition || null,
      aiData.reasoning || null,
      siteId,
    );

  db.close();
  return result.changes > 0;
}

/**
 * Mark a site's AI status (e.g., if there was an error processing it)
 * @param {number} siteId - ID of the site
 * @param {number} status - Status code (1 = processed, 0 = pending/error)
 * @returns {boolean} - True if successful
 */
function updateSiteAIStatus(siteId, status) {
  const db = initDatabase();
  const result = db
    .prepare("UPDATE sites SET ai_processed = 1, ai_status = ? WHERE id = ?")
    .run(status, siteId);
  db.close();
  return result.changes > 0;
}

// ============ NEW CRUD OPERATIONS ============

/**
 * Delete a site and cascade delete its contacts/executives
 * @param {number} id - Site ID
 * @returns {boolean} - Success
 */
function deleteSite(id) {
  const db = initDatabase();
  db.exec('PRAGMA foreign_keys = ON');
  // Manually delete related data to ensure cascade
  db.prepare("DELETE FROM contacts WHERE site_id = ?").run(id);
  db.prepare("DELETE FROM company_executives WHERE site_id = ?").run(id);
  const result = db.prepare("DELETE FROM sites WHERE id = ?").run(id);
  db.close();
  return result.changes > 0;
}

/**
 * Bulk delete multiple sites
 * @param {number[]} ids - Array of site IDs to delete
 * @returns {number} - Number of deleted sites
 */
function bulkDeleteSites(ids) {
  if (!ids || ids.length === 0) return 0;
  const db = initDatabase();
  db.exec('PRAGMA foreign_keys = ON');
  const placeholders = ids.map(() => '?').join(',');
  // Manually delete related data to ensure cascade
  db.prepare(`DELETE FROM contacts WHERE site_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM company_executives WHERE site_id IN (${placeholders})`).run(...ids);
  const result = db.prepare(`DELETE FROM sites WHERE id IN (${placeholders})`).run(...ids);
  db.close();
  return result.changes;
}

/**
 * Get deletion preview - counts of related data that will be deleted
 * @param {number[]} ids - Array of site IDs
 * @returns {Object} - Counts of related data
 */
function getSiteDeletionPreview(ids) {
  if (!ids || ids.length === 0) return { sites: 0, emails: 0, phones: 0, linkedins: 0, executives: 0 };
  const db = initDatabase();
  const placeholders = ids.map(() => '?').join(',');
  
  const sites = ids.length;
  const emails = db.prepare(`SELECT COUNT(*) as count FROM contacts WHERE site_id IN (${placeholders}) AND type = 'email'`).get(...ids).count;
  const phones = db.prepare(`SELECT COUNT(*) as count FROM contacts WHERE site_id IN (${placeholders}) AND type = 'phone'`).get(...ids).count;
  const linkedins = db.prepare(`SELECT COUNT(*) as count FROM contacts WHERE site_id IN (${placeholders}) AND type = 'linkedin'`).get(...ids).count;
  const executives = db.prepare(`SELECT COUNT(*) as count FROM company_executives WHERE site_id IN (${placeholders})`).get(...ids).count;
  
  db.close();
  return { sites, emails, phones, linkedins, executives };
}

/**
 * Update a site
 * @param {number} id - Site ID
 * @param {Object} data - Update data
 * @returns {boolean} - Success
 */
function updateSite(id, data) {
  const db = initDatabase();
  const result = db
    .prepare(
      `
    UPDATE sites 
    SET confidence_score = ?, indicators = ?
    WHERE id = ?
  `,
    )
    .run(data.confidence_score || 0, data.indicators || "", id);
  db.close();
  return result.changes > 0;
}

/**
 * Delete a contact (email/phone/linkedin)
 * @param {number} id - Contact ID
 * @returns {boolean} - Success
 */
function deleteContact(id) {
  const db = initDatabase();
  const result = db.prepare("DELETE FROM contacts WHERE id = ?").run(id);
  db.close();
  return result.changes > 0;
}

/**
 * Update a contact
 * @param {number} id - Contact ID
 * @param {Object} data - Update data
 * @returns {boolean} - Success
 */
function updateContact(id, data) {
  const db = initDatabase();
  const result = db
    .prepare(
      `
    UPDATE contacts 
    SET value = ?
    WHERE id = ?
  `,
    )
    .run(data.value, id);
  db.close();
  return result.changes > 0;
}

/**
 * Delete an executive
 * @param {number} id - Executive ID
 * @returns {boolean} - Success
 */
function deleteExecutive(id) {
  const db = initDatabase();
  const result = db
    .prepare("DELETE FROM company_executives WHERE id = ?")
    .run(id);
  db.close();
  return result.changes > 0;
}

/**
 * Update an executive
 * @param {number} id - Executive ID
 * @param {Object} data - Update data
 * @returns {boolean} - Success
 */
function updateExecutive(id, data) {
  const db = initDatabase();
  const result = db
    .prepare(
      `
    UPDATE company_executives 
    SET name = ?, role_category = ?, headline = ?, profile_url = ?
    WHERE id = ?
  `,
    )
    .run(
      data.name || null,
      data.role_category || null,
      data.headline || null,
      data.profile_url || null,
      id,
    );
  db.close();
  return result.changes > 0;
}

module.exports = {
  initDatabase,
  saveSearchResults,
  getAllSearches,
  getSearchById,
  getAllWordpressSites,
  getStatistics,
  exportToJSON,
  DB_PATH,
  // Keyword CRUD
  getAllKeywords,
  getKeywordById,
  addKeyword,
  updateKeyword,
  deleteKeyword,
  updateKeywordStatus,
  getSitesByWordpressStatus,
  getAllSites,
  getDistinctCategories,
  // Contact retrieval
  getEmails,
  getPhones,
  getContactStats,
  getAllContacts,
  getLinkedinProfiles,
  // Duplicate checking
  urlExists,
  getAllExistingUrls,
  normalizeUrl,
  // Company executives
  saveExecutive,
  getCompanyExecutives,
  getExecutivesStats,
  getExecutivesByCompany,
  // AI Enrichment
  getPendingAISites,
  updateSiteAIResults,
  updateSiteAIStatus,
  // New CRUD operations
  deleteSite,
  bulkDeleteSites,
  getSiteDeletionPreview,
  updateSite,
  deleteContact,
  updateContact,
  deleteExecutive,
  updateExecutive,
  // Low-level SQLite wrappers (used by email-senders-templates-api.js & email-queue-worker.js)
  run,
  all,
  get,
  prepare,
};
