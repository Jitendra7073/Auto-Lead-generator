const express = require("express");
const router = express.Router();
const db = require("./database");
const aiClient = require("./ai-client");
const aiWorker = require("./ai-processor");

// ============================================
// DATABASE TABLES SETUP
// ============================================

/**
 * Initialize database tables for email system
 */
function initializeEmailTables() {
  // Email Senders Table
  db.run(`
    CREATE TABLE IF NOT EXISTS email_senders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      service TEXT DEFAULT 'gmail',
      smtp_host TEXT,
      smtp_port INTEGER,
      daily_limit INTEGER DEFAULT 500,
      is_active INTEGER DEFAULT 1,
      sent_today INTEGER DEFAULT 0,
      last_reset_date TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Email Templates Table
  db.run(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      html_content TEXT NOT NULL,
      text_content TEXT,
      description TEXT,
      category TEXT DEFAULT 'general',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Email Campaigns Table
  db.run(`
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      template_id INTEGER,
      target_type TEXT DEFAULT 'all',
      status TEXT DEFAULT 'queued',
      total_recipients INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (template_id) REFERENCES email_templates(id)
    )
  `);

  // Email Queue Table
  db.run(`
    CREATE TABLE IF NOT EXISTS email_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER,
      sender_id INTEGER,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT,
      subject TEXT NOT NULL,
      html_content TEXT NOT NULL,
      text_content TEXT,
      status TEXT DEFAULT 'queued',
      attempts INTEGER DEFAULT 0,
      error_message TEXT,
      sent_at TEXT,
      scheduled_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id),
      FOREIGN KEY (sender_id) REFERENCES email_senders(id)
    )
  `);

  // Migrate email_queue to include scheduled_at if missing
  try {
    const queueCols = db.prepare("PRAGMA table_info(email_queue)").all();
    if (!queueCols.some((c) => c.name === "scheduled_at")) {
      db.run("ALTER TABLE email_queue ADD COLUMN scheduled_at TEXT");
      console.log("✅ Added scheduled_at column to email_queue table");
    }
  } catch (e) {
    console.warn("⚠️ Could not check/add scheduled_at column", e);
  }

  // Email Settings Table (key-value store for configurable intervals)
  db.run(`
    CREATE TABLE IF NOT EXISTS email_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      label TEXT,
      description TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Email Send Log Table (tracks what was sent to each contact)
  db.run(`
    CREATE TABLE IF NOT EXISTS email_send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      contact_email TEXT NOT NULL,
      template_id INTEGER,
      campaign_id INTEGER,
      send_type TEXT DEFAULT 'main',
      status TEXT DEFAULT 'sent',
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (template_id) REFERENCES email_templates(id)
    )
  `);

  // Seed default settings if they don't exist
  const defaults = [
    {
      key: "per_email_delay",
      value: "60",
      label: "Per-Email Delay (seconds)",
      description: "Seconds to wait between sending each email",
    },
    {
      key: "cycle_cooldown_min",
      value: "10",
      label: "Cycle Cooldown Min (minutes)",
      description: "Minimum minutes to wait after a full sender cycle",
    },
    {
      key: "cycle_cooldown_max",
      value: "13",
      label: "Cycle Cooldown Max (minutes)",
      description:
        "Maximum minutes to wait after a full sender cycle (random between min-max)",
    },
    // Follow-up gap settings (days between sequence steps)
    {
      key: "followup_gap_1",
      value: "2",
      label: "Gap before Follow-up 1 (days)",
      description: "Days to wait after main email before sending follow-up 1",
    },
    {
      key: "followup_gap_2",
      value: "5",
      label: "Gap before Follow-up 2 (days)",
      description: "Days to wait after follow-up 1 before sending follow-up 2",
    },
    {
      key: "followup_gap_3",
      value: "5",
      label: "Gap before Follow-up 3 (days)",
      description: "Days to wait after follow-up 2 before sending follow-up 3",
    },
    {
      key: "followup_gap_4",
      value: "5",
      label: "Gap before Follow-up 4 (days)",
      description: "Days to wait after follow-up 3 before sending follow-up 4",
    },
  ];
  const insertSetting = db.prepare(
    "INSERT OR IGNORE INTO email_settings (key, value, label, description) VALUES (?, ?, ?, ?)",
  );
  for (const s of defaults) {
    insertSetting.run(s.key, s.value, s.label, s.description);
  }

  // Add tags column if not exists (migration)
  try {
    db.run(`ALTER TABLE email_templates ADD COLUMN tags TEXT DEFAULT ''`);
  } catch (e) {
    // Column already exists
  }

  // Add sequence_number column if not exists (migration)
  try {
    db.run(`ALTER TABLE email_templates ADD COLUMN sequence_number INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists
  }

  // Add contact_id column to email_queue if not exists (for tracking sequence sends)
  try {
    db.run(`ALTER TABLE email_queue ADD COLUMN contact_id INTEGER`);
  } catch (e) {
    // Column already exists
  }

  // Add tag column to email_queue if not exists (for tracking tag-based sends)
  try {
    db.run(`ALTER TABLE email_queue ADD COLUMN tag TEXT`);
  } catch (e) {
    // Column already exists
  }

  // Add sequence_position column to email_queue (which step in the sequence)
  try {
    db.run(`ALTER TABLE email_queue ADD COLUMN sequence_position INTEGER`);
  } catch (e) {
    // Column already exists
  }

  // Sync follow-up gap settings based on current template counts
  syncFollowupGapSettings();

  console.log("✅ Email system tables initialized");
}

/**
 * Get max template count across all tag groups
 * @returns {number} The maximum number of templates in any single tag group
 */
function getMaxSequenceCount() {
  const templates = db.all(`SELECT tags FROM email_templates WHERE tags IS NOT NULL AND tags != ''`);
  const tagCounts = {};
  templates.forEach(t => {
    if (t.tags) {
      t.tags.split(',').forEach(tag => {
        const trimmed = tag.trim();
        if (trimmed) {
          tagCounts[trimmed] = (tagCounts[trimmed] || 0) + 1;
        }
      });
    }
  });
  const counts = Object.values(tagCounts);
  return counts.length > 0 ? Math.max(...counts) : 1;
}

/**
 * Sync follow-up gap settings in DB to match current max template sequence count.
 * Creates missing gap settings and removes excess ones.
 */
function syncFollowupGapSettings() {
  const maxSeq = getMaxSequenceCount();
  const neededGaps = Math.max(maxSeq - 1, 0); // N templates need N-1 gaps

  // Insert any missing gap settings
  const insertStmt = db.prepare(
    "INSERT OR IGNORE INTO email_settings (key, value, label, description) VALUES (?, ?, ?, ?)"
  );
  for (let i = 1; i <= neededGaps; i++) {
    const key = `followup_gap_${i}`;
    const label = i === 1
      ? "Gap before Follow-up 1 (days)"
      : `Gap before Follow-up ${i} (days)`;
    const desc = i === 1
      ? "Days to wait after main email before sending follow-up 1"
      : `Days to wait after follow-up ${i - 1} before sending follow-up ${i}`;
    insertStmt.run(key, i === 1 ? "2" : "5", label, desc);
  }

  // Remove excess gap settings that are beyond current max
  db.run(
    `DELETE FROM email_settings WHERE key LIKE 'followup_gap_%' AND CAST(REPLACE(key, 'followup_gap_', '') AS INTEGER) > ?`,
    [neededGaps]
  );
}

// Initialize tables on load
initializeEmailTables();

// ============================================
// TEMPLATE VARIABLE REPLACEMENT
// ============================================

/**
 * Replace template placeholders with actual values
 * @param {string} text - Template text with placeholders
 * @param {Object} data - Data object with values to replace
 * @returns {string} - Text with placeholders replaced
 */
function replaceTemplateVariables(text, data) {
  if (!text) return text;
  
  let result = text;
  
  // Replace all supported placeholders
  const replacements = {
    '{{name}}': data.name || data.company || 'there',
    '{{user}}': data.name || data.company || 'there',  // Alias for {{name}}
    '{{company}}': data.company || '',
    '{{email}}': data.email || '',
    '{{site}}': data.site || data.url || '',
    '{{url}}': data.url || data.site || '',
    '{{domain}}': data.domain || '',
    '{{date}}': new Date().toLocaleDateString(),
    '{{year}}': new Date().getFullYear().toString(),
  };
  
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.split(placeholder).join(value);
  }
  
  return result;
}

/**
 * Get site data for a contact to use in template replacement
 * @param {number} siteId - The site ID
 * @returns {Object} - Site data for template replacement
 */
function getSiteDataForTemplate(siteId) {
  if (!siteId) return {};
  
  const site = db.get("SELECT url, search_query FROM sites WHERE id = ?", [siteId]);
  if (!site) return {};
  
  // Extract domain and company name from URL
  let domain = '';
  let company = '';
  try {
    const urlObj = new URL(site.url);
    domain = urlObj.hostname;
    // Try to extract company name from domain (remove www., .com, etc.)
    company = domain
      .replace(/^www\./, '')
      .replace(/\.(com|net|org|io|co|ai|app|dev|info|biz)(\.[a-z]{2})?$/i, '')
      .split('.')
      .pop()
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase()); // Capitalize first letters
  } catch (e) {
    // URL parsing failed, use raw values
  }
  
  return {
    site: site.url,
    url: site.url,
    domain: domain,
    company: company,
  };
}

// ============================================
// QUEUE CONTROL ENDPOINTS
// ============================================

/**
 * POST /api/email/queue/trigger
 * Immediately start processing the queue
 */
router.post("/queue/trigger", (req, res) => {
  try {
    const result = worker.triggerNow();
    res.json({ success: true, message: result.message });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/queue/pause
 * Pause queue processing
 */
router.post("/queue/pause", (req, res) => {
  try {
    worker.pause();
    res.json({ success: true, message: "Queue paused" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/queue/resume
 * Resume queue processing
 */
router.post("/queue/resume", (req, res) => {
  try {
    worker.resume();
    res.json({ success: true, message: "Queue resumed" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/queue/schedule
 * Schedule specific queue items to start at a specific date/time
 * Body: { queueIds: [1, 2, 3], dateTime: "2026-02-25T14:00:00" }
 */
router.post("/queue/schedule", (req, res) => {
  try {
    const { queueIds, dateTime } = req.body;
    if (
      !dateTime ||
      !queueIds ||
      !Array.isArray(queueIds) ||
      queueIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error: "dateTime and queueIds array are required",
      });
    }

    const placeholders = queueIds.map(() => "?").join(",");
    const query = `UPDATE email_queue SET scheduled_at = ? WHERE id IN (${placeholders})`;

    // Scheduled time must be in ISO UTC or whatever format worker compares.
    // We'll store it as ISO string.
    const isoDateTime = new Date(dateTime).toISOString();

    db.run(query, [isoDateTime, ...queueIds]);

    res.json({
      success: true,
      message: `Scheduled ${queueIds.length} items for ${dateTime}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// EMAIL SENDERS CRUD
// ============================================

/**
 * GET /api/email/senders
 * Get all email senders
 */
router.get("/senders", (req, res) => {
  try {
    const senders = db.all(`
      SELECT
        id,
        name,
        email,
        service,
        smtp_host,
        smtp_port,
        daily_limit,
        is_active,
        sent_today,
        last_reset_date,
        created_at,
        updated_at
      FROM email_senders
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      data: senders,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/email/senders/:id
 * Get single sender (without password)
 */
router.get("/senders/:id", (req, res) => {
  try {
    const sender = db.get(
      `
      SELECT
        id,
        name,
        email,
        service,
        smtp_host,
        smtp_port,
        daily_limit,
        is_active,
        sent_today,
        last_reset_date,
        created_at,
        updated_at
      FROM email_senders
      WHERE id = ?
    `,
      [req.params.id],
    );

    if (!sender) {
      return res.status(404).json({
        success: false,
        error: "Sender not found",
      });
    }

    res.json({
      success: true,
      data: sender,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/email/senders
 * Create new email sender
 */
router.post("/senders", (req, res) => {
  try {
    const {
      name,
      email,
      password,
      service = "gmail",
      smtp_host,
      smtp_port,
      daily_limit = 500,
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: "Name, email, and password are required",
      });
    }

    const result = db.run(
      `
      INSERT INTO email_senders (
        name, email, password, service, smtp_host, smtp_port, daily_limit
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [name, email, password, service, smtp_host, smtp_port, daily_limit],
    );

    res.json({
      success: true,
      data: {
        id: result.lastID,
        name,
        email,
        service,
        daily_limit,
      },
    });
  } catch (error) {
    if (error.message.includes("UNIQUE constraint")) {
      return res.status(400).json({
        success: false,
        error: "Email already exists",
      });
    }
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PUT /api/email/senders/:id
 * Update email sender
 */
router.put("/senders/:id", (req, res) => {
  try {
    const {
      name,
      email,
      password,
      service,
      smtp_host,
      smtp_port,
      daily_limit,
    } = req.body;

    const existing = db.get("SELECT * FROM email_senders WHERE id = ?", [
      req.params.id,
    ]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Sender not found",
      });
    }

    db.run(
      `
      UPDATE email_senders
      SET name = ?,
          email = ?,
          password = COALESCE(?, password),
          service = COALESCE(?, service),
          smtp_host = ?,
          smtp_port = ?,
          daily_limit = COALESCE(?, daily_limit),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [
        name || existing.name,
        email || existing.email,
        password,
        service,
        smtp_host,
        smtp_port,
        daily_limit,
        req.params.id,
      ],
    );

    res.json({
      success: true,
      message: "Sender updated successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/email/senders/:id
 * Delete email sender
 */
router.delete("/senders/:id", (req, res) => {
  try {
    const existing = db.get("SELECT * FROM email_senders WHERE id = ?", [
      req.params.id,
    ]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Sender not found",
      });
    }

    db.run("DELETE FROM email_senders WHERE id = ?", [req.params.id]);

    res.json({
      success: true,
      message: "Sender deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PATCH /api/email/senders/:id/toggle
 * Toggle sender active/inactive
 */
router.patch("/senders/:id/toggle", (req, res) => {
  try {
    const existing = db.get("SELECT * FROM email_senders WHERE id = ?", [
      req.params.id,
    ]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Sender not found",
      });
    }

    const newStatus = existing.is_active === 1 ? 0 : 1;

    db.run(
      `
      UPDATE email_senders
      SET is_active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [newStatus, req.params.id],
    );

    res.json({
      success: true,
      data: {
        id: req.params.id,
        is_active: newStatus,
      },
      message: newStatus === 1 ? "Sender activated" : "Sender deactivated",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/email/senders/:id/test
 * Test email sender connection
 */
router.post("/senders/:id/test", async (req, res) => {
  try {
    const sender = db.get("SELECT * FROM email_senders WHERE id = ?", [
      req.params.id,
    ]);

    if (!sender) {
      return res.status(404).json({
        success: false,
        error: "Sender not found",
      });
    }

    const nodemailer = require("nodemailer");

    let transporterConfig;

    if (sender.service === "custom") {
      transporterConfig = {
        host: sender.smtp_host,
        port: sender.smtp_port,
        secure: sender.smtp_port === 465,
        auth: {
          user: sender.email,
          pass: sender.password,
        },
      };
    } else {
      transporterConfig = {
        service: sender.service,
        auth: {
          user: sender.email,
          pass: sender.password,
        },
      };
    }

    const transporter = nodemailer.createTransport(transporterConfig);

    await new Promise((resolve, reject) => {
      transporter.verify((error, success) => {
        if (error) {
          reject(error);
        } else {
          resolve(success);
        }
      });
    });

    res.json({
      success: true,
      message: "Connection test successful",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// EMAIL TEMPLATES CRUD
// ============================================

/**
 * GET /api/email/templates
 * Get all email templates (with optional tag filter)
 */
router.get("/templates", (req, res) => {
  try {
    const { tag } = req.query;
    
    let query = `
      SELECT
        id,
        name,
        subject,
        html_content,
        description,
        category,
        tags,
        sequence_number,
        is_active,
        created_at,
        updated_at
      FROM email_templates
    `;
    
    const params = [];
    if (tag) {
      query += ` WHERE tags LIKE ?`;
      params.push(`%${tag}%`);
    }
    
    query += ` ORDER BY created_at DESC`;
    
    const templates = db.all(query, params);

    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/email/templates/tags
 * Get all unique tags from templates
 */
router.get("/templates/tags", (req, res) => {
  try {
    const templates = db.all(`SELECT tags FROM email_templates WHERE tags IS NOT NULL AND tags != ''`);
    
    // Extract unique tags from all templates
    const tagsSet = new Set();
    templates.forEach(t => {
      if (t.tags) {
        t.tags.split(',').forEach(tag => {
          const trimmed = tag.trim();
          if (trimmed) tagsSet.add(trimmed);
        });
      }
    });
    
    const tags = Array.from(tagsSet).sort();
    
    res.json({
      success: true,
      data: tags,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/email/templates/max-sequence
 * Returns the maximum template count across all tag groups
 * Used by frontend to dynamically render follow-up gap settings
 */
router.get("/templates/max-sequence", (req, res) => {
  try {
    const maxSeq = getMaxSequenceCount();
    res.json({ success: true, data: { maxSequence: maxSeq } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/email/templates/next-sequence/:category
 * Get the next sequence number for a category (optionally filtered by tag)
 * Query params: ?tag=tagName for tag-based isolation
 */
router.get("/templates/next-sequence/:category", (req, res) => {
  try {
    const category = req.params.category;
    const tag = req.query.tag || '';
    
    // Category display names for auto-naming
    const categoryNames = {
      'general': 'General',
      'outreach': 'Cold Outreach',
      'welcome': 'Welcome',
      'promotion': 'Promotion',
      'followup': 'Follow-up'
    };
    
    const categoryDisplayName = categoryNames[category] || category;
    
    // Build query based on whether tag is provided
    let templates;
    if (tag) {
      // Tag-based isolation: get templates matching both tag AND category
      templates = db.all(
        `SELECT name, sequence_number FROM email_templates WHERE category = ? AND tags LIKE ?`,
        [category, `%${tag}%`]
      );
    } else {
      // No tag: get all templates in category
      templates = db.all(
        `SELECT name, sequence_number FROM email_templates WHERE category = ?`,
        [category]
      );
    }
    
    // First try to use stored sequence numbers
    const storedSequences = templates.map(t => t.sequence_number || 0).filter(n => n > 0);
    
    // Fallback: extract numbers from template names like "Tag-Follow-up-1", "Follow-up-2", etc.
    const nameNumbers = templates.map(t => {
      const match = t.name.match(/[-_\s](\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    }).filter(n => !isNaN(n) && n > 0);
    
    // Use the highest from either source
    const allNumbers = [...storedSequences, ...nameNumbers];
    const maxNumber = allNumbers.length > 0 ? Math.max(...allNumbers) : 0;
    const nextNumber = maxNumber + 1;
    
    // Build suggested name based on tag presence
    let suggestedName;
    if (tag) {
      // Format: "Tag - Category #N" (e.g., "Coupons - Follow-up #1")
      const formattedTag = tag.charAt(0).toUpperCase() + tag.slice(1).toLowerCase();
      suggestedName = `${formattedTag} - ${categoryDisplayName} #${nextNumber}`;
    } else {
      // Format: "Category #N" (e.g., "Follow-up #1")
      suggestedName = `${categoryDisplayName} #${nextNumber}`;
    }
    
    res.json({
      success: true,
      data: {
        category,
        tag,
        categoryDisplayName,
        nextNumber,
        suggestedName
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PUT /api/email/templates/reorder
 * Bulk-update sequence_number for templates within a specific tag group.
 * Body: { tag: string, orderedIds: number[] }
 * orderedIds[0] → sequence_number=1, orderedIds[1] → sequence_number=2, etc.
 * Only updates templates that actually belong to the given tag.
 */
router.put("/templates/reorder", (req, res) => {
  try {
    const { tag, orderedIds } = req.body;

    if (!tag || typeof tag !== "string" || !tag.trim()) {
      return res.status(400).json({
        success: false,
        error: "Tag is required",
      });
    }

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: "orderedIds must be a non-empty array of template IDs",
      });
    }

    const trimmedTag = tag.trim();

    // Validate: fetch all templates that match this tag
    const tagTemplates = db.all(
      `SELECT id, tags FROM email_templates WHERE tags LIKE ?`,
      [`%${trimmedTag}%`]
    );

    // Build a set of valid IDs that truly belong to this tag
    const validIds = new Set();
    for (const t of tagTemplates) {
      if (t.tags) {
        const templateTags = t.tags.split(",").map((s) => s.trim().toLowerCase());
        if (templateTags.includes(trimmedTag.toLowerCase())) {
          validIds.add(t.id);
        }
      }
    }

    // Check for duplicate IDs
    const uniqueIds = new Set(orderedIds);
    if (uniqueIds.size !== orderedIds.length) {
      return res.status(400).json({
        success: false,
        error: "Duplicate template IDs are not allowed",
      });
    }

    // Check all provided IDs belong to this tag
    const invalidIds = orderedIds.filter((id) => !validIds.has(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Template IDs [${invalidIds.join(", ")}] do not belong to tag "${trimmedTag}"`,
      });
    }

    // Check count matches — sequence numbers must be exactly 1..N
    if (orderedIds.length !== validIds.size) {
      return res.status(400).json({
        success: false,
        error: `Expected ${validIds.size} template IDs for tag "${trimmedTag}", but received ${orderedIds.length}`,
      });
    }

    // Use a transaction for atomicity — run individual updates in sequence
    db.run("BEGIN TRANSACTION", []);

    try {
      for (let i = 0; i < orderedIds.length; i++) {
        db.run(
          `UPDATE email_templates SET sequence_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [i + 1, orderedIds[i]]
        );
      }
      db.run("COMMIT", []);
    } catch (txError) {
      db.run("ROLLBACK", []);
      throw txError;
    }

    // Return updated templates for this tag, sorted by new sequence
    const updated = db.all(
      `SELECT id, name, subject, category, tags, sequence_number, is_active, description
       FROM email_templates WHERE tags LIKE ? ORDER BY sequence_number ASC`,
      [`%${trimmedTag}%`]
    );

    // Filter to exact tag match
    const filtered = updated.filter((t) => {
      if (!t.tags) return false;
      const tTags = t.tags.split(",").map((s) => s.trim().toLowerCase());
      return tTags.includes(trimmedTag.toLowerCase());
    });

    console.log(`✅ Reordered ${orderedIds.length} templates in tag "${trimmedTag}"`);

    // Sync gap settings after reorder
    syncFollowupGapSettings();

    res.json({
      success: true,
      message: `Reordered ${orderedIds.length} templates`,
      data: filtered,
    });
  } catch (error) {
    console.error(`❌ Reorder failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/email/templates/active
 * Get only active templates
 */
router.get("/templates/active", (req, res) => {
  try {
    const templates = db.all(`
      SELECT
        id,
        name,
        subject,
        description,
        category,
        tags,
        sequence_number
      FROM email_templates
      WHERE is_active = 1
      ORDER BY name ASC
    `);

    res.json({
      success: true,
      data: templates,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/email/templates/:id
 * Get single template
 */
router.get("/templates/:id", (req, res) => {
  try {
    const template = db.get(
      `
      SELECT * FROM email_templates
      WHERE id = ?
    `,
      [req.params.id],
    );

    if (!template) {
      return res.status(404).json({
        success: false,
        error: "Template not found",
      });
    }

    res.json({
      success: true,
      data: template,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/email/templates
 * Create new email template
 */
router.post("/templates", (req, res) => {
  try {
    const {
      name,
      subject,
      html_content,
      text_content,
      description,
      category = "general",
      tags = "",
    } = req.body;
    
    let { sequence_number = 0 } = req.body;

    if (!name || !subject || !html_content) {
      return res.status(400).json({
        success: false,
        error: "Name, subject, and HTML content are required",
      });
    }

    // Auto-calculate sequence_number if not provided
    if (!sequence_number || sequence_number <= 0) {
      // First check if sequence is in the name
      const seqMatch = name.match(/#(\d+)$/);
      const oldSeqMatch = name.match(/-(\d+)$/);
      
      if (seqMatch) {
        sequence_number = parseInt(seqMatch[1], 10);
      } else if (oldSeqMatch) {
        sequence_number = parseInt(oldSeqMatch[1], 10);
      } else {
        // Calculate next sequence for this tag+category
        const primaryTag = tags.split(',')[0].trim();
        let templates;
        
        if (primaryTag) {
          templates = db.all(
            `SELECT name, sequence_number FROM email_templates WHERE category = ? AND tags LIKE ?`,
            [category, `%${primaryTag}%`]
          );
        } else {
          templates = db.all(
            `SELECT name, sequence_number FROM email_templates WHERE category = ?`,
            [category]
          );
        }
        
        // Get max sequence from stored values and name patterns
        const storedSequences = templates.map(t => t.sequence_number || 0).filter(n => n > 0);
        const nameNumbers = templates.map(t => {
          const match = t.name.match(/[-_#\s](\d+)$/);
          return match ? parseInt(match[1], 10) : 0;
        }).filter(n => !isNaN(n) && n > 0);
        
        const allNumbers = [...storedSequences, ...nameNumbers];
        const maxNumber = allNumbers.length > 0 ? Math.max(...allNumbers) : 0;
        sequence_number = maxNumber + 1;
      }
    }

    const result = db.run(
      `
      INSERT INTO email_templates (
        name, subject, html_content, text_content, description, category, tags, sequence_number
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [name, subject, html_content, text_content, description, category, tags, sequence_number],
    );

    // Sync gap settings after adding a new template
    syncFollowupGapSettings();

    res.json({
      success: true,
      data: {
        id: result.lastID,
        name,
        subject,
        category,
        tags,
        sequence_number,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PUT /api/email/templates/:id
 * Update email template
 */
router.put("/templates/:id", (req, res) => {
  try {
    const { name, subject, html_content, text_content, description, category } =
      req.body;

    const existing = db.get("SELECT * FROM email_templates WHERE id = ?", [
      req.params.id,
    ]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Template not found",
      });
    }

    const { tags, sequence_number } = req.body;
    
    db.run(
      `
      UPDATE email_templates
      SET name = COALESCE(?, name),
          subject = COALESCE(?, subject),
          html_content = COALESCE(?, html_content),
          text_content = COALESCE(?, text_content),
          description = COALESCE(?, description),
          category = COALESCE(?, category),
          tags = COALESCE(?, tags),
          sequence_number = COALESCE(?, sequence_number),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [
        name,
        subject,
        html_content,
        text_content,
        description,
        category,
        tags,
        sequence_number,
        req.params.id,
      ],
    );

    // Sync gap settings after updating a template (tags may have changed)
    syncFollowupGapSettings();

    res.json({
      success: true,
      message: "Template updated successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/email/templates/:id
 * Delete email template
 */
router.delete("/templates/:id", (req, res) => {
  try {
    const existing = db.get("SELECT * FROM email_templates WHERE id = ?", [
      req.params.id,
    ]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Template not found",
      });
    }

    // Check if template is being used by any campaign
    const inUse = db.get(
      "SELECT id FROM email_campaigns WHERE template_id = ?",
      [req.params.id],
    );

    if (inUse) {
      return res.status(400).json({
        success: false,
        error: "Cannot delete template that is in use by campaigns",
      });
    }

    db.run("DELETE FROM email_templates WHERE id = ?", [req.params.id]);

    // Sync gap settings after deleting a template (may reduce max sequence)
    syncFollowupGapSettings();

    res.json({
      success: true,
      message: "Template deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * PATCH /api/email/templates/:id/toggle
 * Toggle template active/inactive
 */
router.patch("/templates/:id/toggle", (req, res) => {
  try {
    const existing = db.get("SELECT * FROM email_templates WHERE id = ?", [
      req.params.id,
    ]);

    if (!existing) {
      return res.status(404).json({
        success: false,
        error: "Template not found",
      });
    }

    const newStatus = existing.is_active === 1 ? 0 : 1;

    db.run(
      `
      UPDATE email_templates
      SET is_active = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [newStatus, req.params.id],
    );

    res.json({
      success: true,
      data: {
        id: req.params.id,
        is_active: newStatus,
      },
      message: newStatus === 1 ? "Template activated" : "Template deactivated",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/email/templates/:id/preview
 * Preview template with test data
 */
router.post("/templates/:id/preview", (req, res) => {
  try {
    const template = db.get("SELECT * FROM email_templates WHERE id = ?", [
      req.params.id,
    ]);

    if (!template) {
      return res.status(404).json({
        success: false,
        error: "Template not found",
      });
    }

    const testData = req.body.data || {
      name: "John Doe",
      company: "Example Inc",
      email: "john@example.com",
    };

    let preview = template.html_content;

    // Replace placeholders
    Object.keys(testData).forEach((key) => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, "gi");
      preview = preview.replace(regex, testData[key]);
    });

    res.json({
      success: true,
      data: {
        subject: template.subject,
        html: preview,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// AI TEMPLATE GENERATION
// ============================================

/**
 * POST /api/email/templates/ai/generate
 * Generate email template using AI
 */
router.post("/templates/ai/generate", async (req, res) => {
  try {
    const { description, category, mode } = req.body;

    if (!description) {
      return res.status(400).json({
        success: false,
        error: "Description is required",
      });
    }

    if (!aiClient.isConfigured()) {
      return res.status(400).json({
        success: false,
        error: "AI is not configured. Please set OPENROUTER_API_KEY in .env",
      });
    }

    const systemPrompt = `You are an expert email copywriter. Generate a professional email template based on the user's description.

Create an email that is:
- Professional and engaging
- Personalized using template variables
- Optimized for conversions and responses
- Clear and concise

Available template variables (use these where appropriate):
- {{name}} - Recipient's name
- {{company}} - Company name
- {{email}} - Recipient's email
- {{site}} - Their website URL
- {{domain}} - Their domain name
- {{date}} - Today's date
- {{year}} - Current year

Return JSON:
{
  "name": "Suggested template name",
  "subject": "Email subject line (can include {{name}} or {{company}})",
  "html_content": "Full HTML email content with proper formatting, paragraphs, and personalization",
  "text_content": "Plain text version of the email"
}`;

    const userMessage = `Generate an email template for: ${description}
    
${category ? `Category: ${category}` : ''}

Make it professional, personalized, and conversion-focused.`;

    const startTime = Date.now();
    const result = await aiClient.chatJSON(systemPrompt, userMessage);
    const elapsed = Date.now() - startTime;

    // Track this request in history
    aiWorker.addToHistory({
      type: 'template_generation',
      provider: 'OpenRouter',
      model: aiClient.getStats().model,
      success: true,
      responseTime: elapsed,
      tokens: result.usage?.total_tokens || 0,
      description: description.substring(0, 50)
    });

    res.json({
      success: true,
      data: result.content,
      usage: result.usage,
    });
  } catch (error) {
    console.error("❌ AI template generation failed:", error.message);
    
    // Track failed request
    aiWorker.addToHistory({
      type: 'template_generation',
      provider: 'OpenRouter',
      model: aiClient.getStats().model,
      success: false,
      responseTime: 0,
      tokens: 0,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/email/templates/ai/refine
 * Refine existing template content with AI
 */
router.post("/templates/ai/refine", async (req, res) => {
  try {
    const { subject, html_content, instruction } = req.body;

    if (!subject && !html_content) {
      return res.status(400).json({
        success: false,
        error: "Subject or HTML content is required",
      });
    }

    if (!instruction) {
      return res.status(400).json({
        success: false,
        error: "Refinement instruction is required",
      });
    }

    if (!aiClient.isConfigured()) {
      return res.status(400).json({
        success: false,
        error: "AI is not configured. Please set OPENROUTER_API_KEY in .env",
      });
    }

    const systemPrompt = `You are an expert email copywriter. Refine the given email template based on the user's instruction.

Maintain the same template variables that are used:
- {{name}}, {{company}}, {{email}}, {{site}}, {{domain}}, {{date}}, {{year}}

Return JSON:
{
  "subject": "Refined subject line",
  "html_content": "Refined HTML email content",
  "text_content": "Refined plain text version"
}`;

    const userMessage = `CURRENT EMAIL:
Subject: ${subject || '(none)'}
Content: ${html_content || '(none)'}

REFINEMENT INSTRUCTION: ${instruction}

Please refine this email according to the instruction while maintaining professional quality.`;

    const startTime = Date.now();
    const result = await aiClient.chatJSON(systemPrompt, userMessage);
    const elapsed = Date.now() - startTime;

    // Track this request in history
    aiWorker.addToHistory({
      type: 'template_refinement',
      provider: 'OpenRouter',
      model: aiClient.getStats().model,
      success: true,
      responseTime: elapsed,
      tokens: result.usage?.total_tokens || 0,
      instruction: instruction.substring(0, 50)
    });

    res.json({
      success: true,
      data: result.content,
      usage: result.usage,
    });
  } catch (error) {
    console.error("❌ AI template refinement failed:", error.message);
    
    // Track failed request
    aiWorker.addToHistory({
      type: 'template_refinement',
      provider: 'OpenRouter',
      model: aiClient.getStats().model,
      success: false,
      responseTime: 0,
      tokens: 0,
      error: error.message
    });
    
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// ACTIVE SENDERS & TEMPLATES
// ============================================

/**
 * GET /api/email/senders/active
 * Get only active senders
 */
router.get("/senders/active", (req, res) => {
  try {
    const senders = db.all(`
      SELECT
        id,
        name,
        email,
        service,
        smtp_host,
        smtp_port,
        daily_limit,
        sent_today
      FROM email_senders
      WHERE is_active = 1
      ORDER BY created_at ASC
    `);

    res.json({
      success: true,
      data: senders,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// CAMPAIGNS CRUD
// ============================================

/**
 * GET /api/email/campaigns
 * Get all email campaigns
 */
router.get("/campaigns", (req, res) => {
  try {
    const campaigns = db.all(`
      SELECT
        c.id,
        c.name,
        c.template_id,
        c.target_type,
        c.status,
        c.total_recipients,
        c.sent_count,
        c.failed_count,
        c.created_at,
        c.started_at,
        c.completed_at,
        t.name as template_name
      FROM email_campaigns c
      LEFT JOIN email_templates t ON c.template_id = t.id
      ORDER BY c.created_at DESC
    `);

    res.json({
      success: true,
      data: campaigns,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/email/campaigns
 * Create a new email campaign and queue emails
 */
router.post("/campaigns", (req, res) => {
  try {
    const { name, template_id, target_type, status = "queued" } = req.body;

    if (!name || !template_id || !target_type) {
      return res.status(400).json({
        success: false,
        error: "Name, template, and target type are required",
      });
    }

    // 1. Create the campaign record First
    const result = db.run(
      `INSERT INTO email_campaigns (name, template_id, target_type, status)
       VALUES (?, ?, ?, ?)`,
      [name, template_id, target_type, status],
    );
    const campaignId = result.lastInsertRowid;

    // 2. Fetch the template
    const template = db.get("SELECT * FROM email_templates WHERE id = ?", [
      template_id,
    ]);
    if (!template) {
      throw new Error("Template not found");
    }

    // 3. Find target recipients based on target_type
    let emailsToQueue = [];
    if (target_type === "all") {
      const contacts = db.all(
        "SELECT value as email, site_id FROM contacts WHERE type = 'email' AND value IS NOT NULL",
      );
      emailsToQueue = contacts.map((c) => ({
        email: c.email,
        site_id: c.site_id,
      }));
    } else if (target_type === "wordpress") {
      const contacts = db.all(`
        SELECT c.value as email, c.site_id
        FROM contacts c
        JOIN sites s ON c.site_id = s.id
        WHERE c.type = 'email' AND c.value IS NOT NULL AND s.is_wordpress = 1
      `);
      emailsToQueue = contacts.map((c) => ({
        email: c.email,
        site_id: c.site_id,
      }));
    } else if (target_type === "executives") {
      // Assuming executives might have an email column or we just pull from contacts if there's a link.
      // For now, this is a placeholder if they have emails in company_executives
    }

    // Dedup essentially
    const uniqueEmails = [
      ...new Map(emailsToQueue.map((item) => [item.email, item])).values(),
    ];

    // 4. Queue them up!
    let queuedCount = 0;

    for (const target of uniqueEmails) {
      // Get site data for template variable replacement
      const siteData = getSiteDataForTemplate(target.site_id);
      const templateData = {
        ...siteData,
        email: target.email,
      };
      
      // Replace template variables with actual values
      const processedSubject = replaceTemplateVariables(template.subject, templateData);
      const processedHtml = replaceTemplateVariables(template.html_content, templateData);
      const processedText = replaceTemplateVariables(template.text_content || "", templateData);

      db.run(
        `
        INSERT INTO email_queue (campaign_id, recipient_email, subject, html_content, text_content, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        [
          campaignId,
          target.email,
          processedSubject,
          processedHtml,
          processedText,
          "queued",
        ],
      );
      queuedCount++;
    }

    // Update total recipients
    db.run("UPDATE email_campaigns SET total_recipients = ? WHERE id = ?", [
      queuedCount,
      campaignId,
    ]);

    // If status is 'sending', worker will pick it up automatically
    res.json({
      success: true,
      message: `Campaign created and ${queuedCount} emails queued.`,
      data: { campaign_id: campaignId, queued: queuedCount },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/email/queue/stats
 * Retrieve queue statistics for the frontend dashboard
 */
router.get("/queue/stats", (req, res) => {
  try {
    // Total queued
    const queuedCountRes = db.get(
      "SELECT COUNT(*) as count FROM email_queue WHERE status = 'queued'",
    );
    // Sent today
    const sentTodayRes = db.get(
      "SELECT COUNT(*) as count FROM email_queue WHERE status = 'sent' AND date(sent_at) = date('now')",
    );
    // Failed
    const failedCountRes = db.get(
      "SELECT COUNT(*) as count FROM email_queue WHERE status = 'failed'",
    );

    // Active processing check
    const isProcessingRes = db.get(
      "SELECT COUNT(*) as count FROM email_queue WHERE status = 'sending'",
    );

    // Accounts status
    const accounts = db.all(
      "SELECT name, sent_today as sentToday, daily_limit as dailyLimit FROM email_senders WHERE is_active = 1",
    );

    res.json({
      success: true,
      data: {
        queue: {
          isProcessing: isProcessingRes.count > 0,
          total: queuedCountRes.count,
        },
        sent: {
          today: sentTodayRes.count,
        },
        failed: failedCountRes.count,
        accounts: accounts,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/email/campaigns/:id
 * Retrieve a single campaign by ID
 */
router.get("/campaigns/:id", (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = db.get(
      `SELECT c.*, c.total_recipients as recipients_count, t.name as template_name 
       FROM email_campaigns c 
       LEFT JOIN email_templates t ON c.template_id = t.id 
       WHERE c.id = ?`,
      [campaignId],
    );

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    res.json({
      success: true,
      data: campaign,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/email/campaigns/:id
 * Delete a campaign and its associated queue items
 */
router.delete("/campaigns/:id", (req, res) => {
  try {
    const campaignId = req.params.id;

    // Delete associated queue items first
    db.run("DELETE FROM email_queue WHERE campaign_id = ?", [campaignId]);

    // Delete the campaign itself
    db.run("DELETE FROM email_campaigns WHERE id = ?", [campaignId]);

    res.json({
      success: true,
      message: "Campaign and associated queue items deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============================================
// EMAIL SETTINGS CRUD
// ============================================

/**
 * GET /api/email/settings
 * Get all email settings
 */
router.get("/settings", (req, res) => {
  try {
    const settings = db.all("SELECT * FROM email_settings ORDER BY key ASC");
    // Convert to object for easier frontend use
    const settingsObj = {};
    settings.forEach((s) => {
      settingsObj[s.key] = s;
    });
    res.json({ success: true, data: settingsObj, list: settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/email/settings
 * Update email settings (accepts object of key-value pairs)
 */
router.put("/settings", (req, res) => {
  try {
    const updates = req.body; // { per_email_delay: '90', cycle_cooldown_min: '12', ... }
    const stmt = db.prepare(
      "UPDATE email_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?",
    );
    let updated = 0;
    for (const [key, value] of Object.entries(updates)) {
      const result = stmt.run(String(value), key);
      if (result.changes > 0) updated++;
    }
    res.json({ success: true, message: `${updated} settings updated` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// QUEUE SELECTED EMAILS
// ============================================

/**
 * POST /api/email/queue/add-selected
 * Queue specific contact IDs with a chosen template
 * Body: { contact_ids: [1,2,3], template_id: 5, send_type: 'main' }
 */
router.post("/queue/add-selected", (req, res) => {
  try {
    const { contact_ids, template_id, send_type = "main" } = req.body;

    if (
      !contact_ids ||
      !Array.isArray(contact_ids) ||
      contact_ids.length === 0
    ) {
      return res
        .status(400)
        .json({ success: false, error: "No contacts selected" });
    }
    if (!template_id) {
      return res
        .status(400)
        .json({ success: false, error: "Template is required" });
    }

    // Fetch template
    const template = db.get("SELECT * FROM email_templates WHERE id = ?", [
      template_id,
    ]);
    if (!template) {
      return res
        .status(404)
        .json({ success: false, error: "Template not found" });
    }

    // Create a campaign record for tracking
    const campaignResult = db.run(
      `INSERT INTO email_campaigns (name, template_id, target_type, status)
       VALUES (?, ?, ?, ?)`,
      [
        `Manual Queue - ${new Date().toLocaleDateString()}`,
        template_id,
        "selected",
        "queued",
      ],
    );
    const campaignId = campaignResult.lastInsertRowid;

    // Fetch contacts by IDs
    const placeholders = contact_ids.map(() => "?").join(",");
    const contacts = db.all(
      `SELECT id, value as email, site_id FROM contacts WHERE id IN (${placeholders}) AND type = 'email'`,
      contact_ids,
    );

    let queuedCount = 0;
    const insertQueue = db.prepare(
      `INSERT INTO email_queue (campaign_id, recipient_email, subject, html_content, text_content, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
    );
    const insertLog = db.prepare(
      `INSERT INTO email_send_log (contact_id, contact_email, template_id, campaign_id, send_type, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
    );

    for (const contact of contacts) {
      // Get site data for template variable replacement
      const siteData = getSiteDataForTemplate(contact.site_id);
      const templateData = {
        ...siteData,
        email: contact.email,
      };
      
      // Replace template variables with actual values
      const processedSubject = replaceTemplateVariables(template.subject, templateData);
      const processedHtml = replaceTemplateVariables(template.html_content, templateData);
      const processedText = replaceTemplateVariables(template.text_content || "", templateData);
      
      insertQueue.run(
        campaignId,
        contact.email,
        processedSubject,
        processedHtml,
        processedText,
      );
      insertLog.run(
        contact.id,
        contact.email,
        template_id,
        campaignId,
        send_type,
      );
      queuedCount++;
    }

    // Update campaign total
    db.run("UPDATE email_campaigns SET total_recipients = ? WHERE id = ?", [
      queuedCount,
      campaignId,
    ]);

    res.json({
      success: true,
      message: `${queuedCount} emails added to queue`,
      data: { campaign_id: campaignId, queued: queuedCount },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// QUEUE BY TAG (AUTO-SEQUENCE)
// ============================================

/**
 * POST /api/email/queue/add-by-tag
 * Queue contacts using tag-based auto-sequencing.
 * Queues ALL remaining templates in the sequence with scheduled_at dates
 * based on follow-up gap settings.
 * Body: { contact_ids: [1,2,3], tag: 'coupon' }
 */
router.post("/queue/add-by-tag", (req, res) => {
  try {
    const { contact_ids, tag } = req.body;

    if (!contact_ids || !Array.isArray(contact_ids) || contact_ids.length === 0) {
      return res.status(400).json({ success: false, error: "No contacts selected" });
    }
    if (!tag || typeof tag !== "string" || tag.trim() === "") {
      return res.status(400).json({ success: false, error: "Tag is required" });
    }

    const trimmedTag = tag.trim();

    // Get all active templates for this tag, ordered by sequence_number
    const tagTemplates = db.all(
      `SELECT * FROM email_templates 
       WHERE is_active = 1 AND tags LIKE ? 
       ORDER BY sequence_number ASC`,
      [`%${trimmedTag}%`]
    ).filter(t => {
      // Exact tag match (tags is comma-separated)
      const templateTags = (t.tags || '').split(',').map(s => s.trim().toLowerCase());
      return templateTags.includes(trimmedTag.toLowerCase());
    });

    if (tagTemplates.length === 0) {
      return res.status(404).json({
        success: false,
        error: `No active templates found for tag "${trimmedTag}"`,
      });
    }

    const templateIds = tagTemplates.map(t => t.id);

    // Fetch contacts by IDs
    const placeholders = contact_ids.map(() => "?").join(",");
    const contacts = db.all(
      `SELECT id, value as email, site_id FROM contacts WHERE id IN (${placeholders}) AND type = 'email'`,
      contact_ids
    );

    if (contacts.length === 0) {
      return res.status(404).json({ success: false, error: "No valid email contacts found" });
    }

    // Load follow-up gap settings (in days) - dynamic based on DB entries
    const gapSettings = {};
    const settingsRows = db.all("SELECT key, value FROM email_settings WHERE key LIKE 'followup_gap_%' ORDER BY CAST(REPLACE(key, 'followup_gap_', '') AS INTEGER) ASC");
    settingsRows.forEach(s => { gapSettings[s.key] = parseInt(s.value) || 0; });
    
    // Build gaps array dynamically: index 0 = main (immediate), index N = followup_gap_N
    const gaps = [0]; // main = immediate
    for (let i = 1; i <= Object.keys(gapSettings).length; i++) {
      gaps.push(gapSettings[`followup_gap_${i}`] || (i === 1 ? 2 : 5));
    }

    // Create a campaign record
    const campaignResult = db.run(
      `INSERT INTO email_campaigns (name, template_id, target_type, status)
       VALUES (?, ?, ?, ?)`,
      [
        `Tag: ${trimmedTag} - ${new Date().toLocaleDateString()}`,
        tagTemplates[0].id,
        "selected",
        "queued",
      ]
    );
    const campaignId = campaignResult.lastInsertRowid;

    const insertQueue = db.prepare(
      `INSERT INTO email_queue (campaign_id, recipient_email, subject, html_content, text_content, status, scheduled_at, contact_id, tag, sequence_position)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
    );
    const insertLog = db.prepare(
      `INSERT INTO email_send_log (contact_id, contact_email, template_id, campaign_id, send_type, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`
    );

    let queuedCount = 0;
    let scheduledCount = 0;
    let skippedCount = 0;
    const details = [];

    for (const contact of contacts) {
      // Find which templates from this tag have already been sent/queued for this contact
      const tplPlaceholders = templateIds.map(() => "?").join(",");
      const sentTemplates = db.all(
        `SELECT DISTINCT template_id FROM email_send_log 
         WHERE contact_id = ? AND template_id IN (${tplPlaceholders})`,
        [contact.id, ...templateIds]
      );
      const sentTemplateIds = new Set(sentTemplates.map(s => s.template_id));

      // Get all remaining (unsent) templates in sequence order
      const remainingTemplates = tagTemplates.filter(t => !sentTemplateIds.has(t.id));

      if (remainingTemplates.length === 0) {
        skippedCount++;
        details.push({ email: contact.email, status: "skipped", reason: "all_sent" });
        continue;
      }

      // Queue ALL remaining templates with appropriate scheduling
      let cumulativeDays = 0;
      remainingTemplates.forEach((template, idx) => {
        const seqIndex = tagTemplates.indexOf(template);
        const sendType = seqIndex === 0 ? "main" : `followup_${seqIndex}`;

        // Calculate scheduled_at:
        // First remaining template = immediate (no gap)
        // Subsequent templates = cumulative gaps from the gap settings
        let scheduledAt = null;
        if (idx === 0) {
          // First remaining template sends immediately
          scheduledAt = null;
        } else {
          // Use the gap for this sequence position
          const gapDays = gaps[seqIndex] || gaps[gaps.length - 1] || 5;
          cumulativeDays += gapDays;
          const schedDate = new Date();
          schedDate.setDate(schedDate.getDate() + cumulativeDays);
          scheduledAt = schedDate.toISOString();
        }

        // Get site data for template variable replacement
        const siteData = getSiteDataForTemplate(contact.site_id);
        const templateData = { ...siteData, email: contact.email };

        const processedSubject = replaceTemplateVariables(template.subject, templateData);
        const processedHtml = replaceTemplateVariables(template.html_content, templateData);
        const processedText = replaceTemplateVariables(template.text_content || "", templateData);

        insertQueue.run(
          campaignId,
          contact.email,
          processedSubject,
          processedHtml,
          processedText,
          scheduledAt,
          contact.id,
          trimmedTag,
          seqIndex + 1
        );
        insertLog.run(contact.id, contact.email, template.id, campaignId, sendType);

        if (scheduledAt) {
          scheduledCount++;
        } else {
          queuedCount++;
        }

        details.push({
          email: contact.email,
          status: scheduledAt ? "scheduled" : "queued",
          template: template.name,
          sendType,
          scheduledAt: scheduledAt || "immediate",
          daysFromNow: cumulativeDays,
        });
      });
    }

    // Update campaign total
    const totalQueued = queuedCount + scheduledCount;
    db.run("UPDATE email_campaigns SET total_recipients = ? WHERE id = ?", [totalQueued, campaignId]);

    // If nothing was queued, clean up the empty campaign
    if (totalQueued === 0) {
      db.run("DELETE FROM email_campaigns WHERE id = ?", [campaignId]);
    }

    res.json({
      success: true,
      message: `${queuedCount} emails queued immediately, ${scheduledCount} scheduled as follow-ups, ${skippedCount} skipped`,
      data: {
        campaign_id: totalQueued > 0 ? campaignId : null,
        queued: queuedCount,
        scheduled: scheduledCount,
        skipped: skippedCount,
        tag: trimmedTag,
        total_templates: tagTemplates.length,
        gaps: gaps.slice(1),
        details,
      },
    });
  } catch (error) {
    console.error(`❌ Add-by-tag error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// CONTACT EMAIL HISTORY & QUEUE CANCEL
// ============================================

/**
 * GET /api/email/contact/:contactId/history
 * Get full send history + queued/scheduled items for a specific contact.
 * Returns a unified timeline of all email activity.
 */
router.get("/contact/:contactId/history", (req, res) => {
  try {
    const contactId = parseInt(req.params.contactId);
    if (!contactId) {
      return res.status(400).json({ success: false, error: "Invalid contact ID" });
    }

    // Get send log entries with template names
    const sendLog = db.all(`
      SELECT esl.id as log_id, esl.template_id, esl.send_type, esl.status, esl.sent_at,
             esl.campaign_id,
             et.name as template_name, et.tags as template_tags, et.sequence_number
      FROM email_send_log esl
      LEFT JOIN email_templates et ON esl.template_id = et.id
      WHERE esl.contact_id = ?
      ORDER BY esl.sent_at ASC
    `, [contactId]);

    // Get queue items for this contact (includes scheduled future items)
    const queueItems = db.all(`
      SELECT eq.id as queue_id, eq.subject, eq.status, eq.scheduled_at, eq.created_at,
             eq.sent_at, eq.tag, eq.sequence_position, eq.campaign_id, eq.recipient_email
      FROM email_queue eq
      WHERE eq.contact_id = ?
      ORDER BY eq.created_at ASC
    `, [contactId]);

    // Build unified timeline
    const timeline = [];

    // Add send log entries
    sendLog.forEach(log => {
      // Find matching queue item for richer data
      const matchingQueue = queueItems.find(q =>
        q.campaign_id === log.campaign_id && q.sequence_position === log.sequence_number
      );

      timeline.push({
        type: "log",
        logId: log.log_id,
        queueId: matchingQueue?.queue_id || null,
        templateId: log.template_id,
        templateName: log.template_name || "Unknown Template",
        templateTags: log.template_tags || "",
        sequenceNumber: log.sequence_number || 0,
        sendType: log.send_type,
        status: matchingQueue?.status || log.status,
        sentAt: matchingQueue?.sent_at || log.sent_at,
        scheduledAt: matchingQueue?.scheduled_at || null,
        createdAt: matchingQueue?.created_at || log.sent_at,
        tag: matchingQueue?.tag || "",
      });
    });

    // Add queue items that don't have a matching send log (shouldn't happen normally, but safety)
    queueItems.forEach(q => {
      const alreadyInTimeline = timeline.some(t => t.queueId === q.queue_id);
      if (!alreadyInTimeline) {
        timeline.push({
          type: "queue_only",
          logId: null,
          queueId: q.queue_id,
          templateId: null,
          templateName: q.subject,
          templateTags: q.tag || "",
          sequenceNumber: q.sequence_position || 0,
          sendType: null,
          status: q.status,
          sentAt: q.sent_at,
          scheduledAt: q.scheduled_at,
          createdAt: q.created_at,
          tag: q.tag || "",
        });
      }
    });

    // Sort by created_at / scheduled_at
    timeline.sort((a, b) => {
      const dateA = new Date(a.scheduledAt || a.createdAt || a.sentAt || 0);
      const dateB = new Date(b.scheduledAt || b.createdAt || b.sentAt || 0);
      return dateA - dateB;
    });

    // Get contact info
    const contact = db.get("SELECT id, value as email, site_id FROM contacts WHERE id = ?", [contactId]);

    res.json({
      success: true,
      data: {
        contact: contact || { id: contactId, email: "Unknown" },
        timeline,
        summary: {
          total: timeline.length,
          sent: timeline.filter(t => t.status === "sent").length,
          queued: timeline.filter(t => t.status === "queued" && !t.scheduledAt).length,
          scheduled: timeline.filter(t => t.status === "queued" && t.scheduledAt).length,
          failed: timeline.filter(t => t.status === "failed").length,
        },
      },
    });
  } catch (error) {
    console.error(`❌ Contact history error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/email/queue/cancel/:queueId
 * Cancel a specific queued/scheduled email.
 * Removes from queue and send log.
 */
router.delete("/queue/cancel/:queueId", (req, res) => {
  try {
    const queueId = parseInt(req.params.queueId);
    if (!queueId) {
      return res.status(400).json({ success: false, error: "Invalid queue ID" });
    }

    // Get the queue item first
    const item = db.get("SELECT * FROM email_queue WHERE id = ?", [queueId]);
    if (!item) {
      return res.status(404).json({ success: false, error: "Queue item not found" });
    }

    // Only allow cancelling queued items (not already sent)
    if (item.status === "sent") {
      return res.status(400).json({ success: false, error: "Cannot cancel already sent email" });
    }

    // Delete from queue
    db.run("DELETE FROM email_queue WHERE id = ?", [queueId]);

    // Delete matching send log entry (if exists)
    if (item.contact_id && item.campaign_id && item.sequence_position) {
      db.run(
        `DELETE FROM email_send_log 
         WHERE contact_id = ? AND campaign_id = ? 
         AND send_type = (
           SELECT CASE WHEN ? = 1 THEN 'main' ELSE 'followup_' || (? - 1) END
         )`,
        [item.contact_id, item.campaign_id, item.sequence_position, item.sequence_position]
      );
    }

    // Update campaign total
    if (item.campaign_id) {
      db.run("UPDATE email_campaigns SET total_recipients = total_recipients - 1 WHERE id = ? AND total_recipients > 0",
        [item.campaign_id]);
    }

    console.log(`✅ Cancelled queue item #${queueId}`);
    res.json({ success: true, message: "Email removed from queue successfully" });
  } catch (error) {
    console.error(`❌ Cancel queue error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/email/queue/send-now/:queueId
 * Send a scheduled/queued email immediately by clearing its scheduled_at.
 * The queue worker will pick it up on the next cycle.
 */
router.post("/queue/send-now/:queueId", (req, res) => {
  try {
    const queueId = parseInt(req.params.queueId);
    if (!queueId) {
      return res.status(400).json({ success: false, error: "Invalid queue ID" });
    }

    const item = db.get("SELECT * FROM email_queue WHERE id = ?", [queueId]);
    if (!item) {
      return res.status(404).json({ success: false, error: "Queue item not found" });
    }

    if (item.status === "sent") {
      return res.status(400).json({ success: false, error: "Email already sent" });
    }

    // Clear scheduled_at so the worker picks it up immediately
    db.run(
      "UPDATE email_queue SET scheduled_at = NULL, status = 'queued' WHERE id = ?",
      [queueId]
    );

    console.log(`✅ Queue item #${queueId} moved to send-now`);
    res.json({ success: true, message: "Email moved to immediate queue — will send shortly" });
  } catch (error) {
    console.error(`❌ Send-now error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/email/send-log
 * Get send log for all contacts (for the Sent Status column)
 * Returns latest send_type per contact_id
 */
router.get("/send-log", (req, res) => {
  try {
    const logs = db.all(`
      SELECT esl.contact_id, esl.contact_email, esl.send_type, esl.status,
             esl.sent_at as last_sent, et.name as template_name
      FROM email_send_log esl
      LEFT JOIN email_templates et ON esl.template_id = et.id
      INNER JOIN (
        SELECT contact_id, MAX(rowid) as max_rowid
        FROM email_send_log
        GROUP BY contact_id
      ) latest ON esl.contact_id = latest.contact_id AND esl.rowid = latest.max_rowid
      ORDER BY esl.sent_at DESC
    `);
    // Convert to a map for quick lookup
    const logMap = {};
    logs.forEach((l) => {
      logMap[l.contact_id] = l;
    });
    res.json({ success: true, data: logMap });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// QUEUE ITEMS DETAIL ENDPOINTS
// ============================================

/**
 * GET /api/email/queue/items
 * Get queue items filtered by status
 * Query params: status=queued|sent|failed|paused|sending, today=true (for sent)
 */
router.get("/queue/items", (req, res) => {
  try {
    const { status, today } = req.query;
    let sql = "";
    let params = [];

    if (status === "sent" && today === "true") {
      sql = `
        SELECT eq.id, eq.recipient_email, eq.subject, eq.status, eq.attempts,
               eq.error_message, eq.sent_at, eq.created_at,
               es.name as sender_name, es.email as sender_email,
               ec.name as campaign_name
        FROM email_queue eq
        LEFT JOIN email_senders es ON eq.sender_id = es.id
        LEFT JOIN email_campaigns ec ON eq.campaign_id = ec.id
        WHERE eq.status = 'sent' AND date(eq.sent_at) = date('now')
        ORDER BY eq.sent_at DESC
      `;
    } else if (status === "failed") {
      sql = `
        SELECT eq.id, eq.recipient_email, eq.subject, eq.status, eq.attempts,
               eq.error_message, eq.sent_at, eq.created_at,
               es.name as sender_name, es.email as sender_email,
               ec.name as campaign_name
        FROM email_queue eq
        LEFT JOIN email_senders es ON eq.sender_id = es.id
        LEFT JOIN email_campaigns ec ON eq.campaign_id = ec.id
        WHERE eq.status = 'failed'
        ORDER BY eq.created_at DESC
      `;
    } else if (status === "scheduled") {
      sql = `
        SELECT eq.id, eq.recipient_email, eq.subject, eq.status, eq.attempts,
               eq.error_message, eq.scheduled_at, eq.created_at,
               ec.name as campaign_name,
               ROW_NUMBER() OVER (ORDER BY eq.scheduled_at ASC) as queue_rank
        FROM email_queue eq
        LEFT JOIN email_campaigns ec ON eq.campaign_id = ec.id
        WHERE eq.status IN ('queued', 'paused') AND eq.scheduled_at IS NOT NULL AND eq.scheduled_at > CURRENT_TIMESTAMP
        ORDER BY eq.scheduled_at ASC
      `;
    } else {
      // Default: queued + sending + paused (without scheduled)
      sql = `
        SELECT eq.id, eq.recipient_email, eq.subject, eq.status, eq.attempts,
               eq.error_message, eq.sent_at, eq.created_at, eq.scheduled_at,
               ec.name as campaign_name,
               ROW_NUMBER() OVER (ORDER BY eq.id ASC) as queue_rank
        FROM email_queue eq
        LEFT JOIN email_campaigns ec ON eq.campaign_id = ec.id
        WHERE eq.status IN ('queued', 'sending', 'paused') AND (eq.scheduled_at IS NULL OR eq.scheduled_at <= CURRENT_TIMESTAMP)
        ORDER BY eq.id ASC
      `;
    }

    const items = db.all(sql, params);
    res.json({ success: true, data: items, total: items.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/email/queue/items/:id/pause
 * Pause a specific queue item
 */
router.patch("/queue/items/:id/pause", (req, res) => {
  try {
    const item = db.get("SELECT * FROM email_queue WHERE id = ?", [
      req.params.id,
    ]);
    if (!item) {
      return res
        .status(404)
        .json({ success: false, error: "Queue item not found" });
    }
    if (item.status !== "queued" && item.status !== "sending") {
      return res.status(400).json({
        success: false,
        error: "Only queued/sending items can be paused",
      });
    }
    db.run("UPDATE email_queue SET status = 'paused' WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ success: true, message: "Queue item paused" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/email/queue/items/:id/resume
 * Resume a paused queue item
 */
router.patch("/queue/items/:id/resume", (req, res) => {
  try {
    const item = db.get("SELECT * FROM email_queue WHERE id = ?", [
      req.params.id,
    ]);
    if (!item) {
      return res
        .status(404)
        .json({ success: false, error: "Queue item not found" });
    }
    if (item.status !== "paused") {
      return res
        .status(400)
        .json({ success: false, error: "Only paused items can be resumed" });
    }
    db.run("UPDATE email_queue SET status = 'queued' WHERE id = ?", [
      req.params.id,
    ]);
    res.json({ success: true, message: "Queue item resumed" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
