/**
 * Database Reset Script
 * Clears all data or resets the database to a clean state
 *
 * Usage:
 *   node reset-db.js                 # Interactive mode
 *   node reset-db.js --all           # Clear all data (keeps tables)
 *   node reset-db.js --leads         # Clear only leads data (sites, contacts, executives)
 *   node reset-db.js --email         # Clear only email system data
 *   node reset-db.js --keywords      # Clear only keywords
 *   node reset-db.js --full          # Delete database file completely (nuclear option)
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

const DB_PATH = path.join(__dirname, "wordpress-detector.db");

// ANSI colors for terminal
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

/**
 * Get current database statistics
 */
function getStats() {
  if (!fs.existsSync(DB_PATH)) {
    return null;
  }

  const db = new Database(DB_PATH);
  const stats = {};

  try {
    stats.searches = db.prepare("SELECT COUNT(*) as count FROM searches").get()?.count || 0;
    stats.sites = db.prepare("SELECT COUNT(*) as count FROM sites").get()?.count || 0;
    stats.wordpressSites = db.prepare("SELECT COUNT(*) as count FROM sites WHERE is_wordpress = 1").get()?.count || 0;
    stats.contacts = db.prepare("SELECT COUNT(*) as count FROM contacts").get()?.count || 0;
    stats.keywords = db.prepare("SELECT COUNT(*) as count FROM keywords").get()?.count || 0;
    stats.executives = db.prepare("SELECT COUNT(*) as count FROM company_executives").get()?.count || 0;
    
    // Email system tables (may not exist)
    try {
      stats.emailSenders = db.prepare("SELECT COUNT(*) as count FROM email_senders").get()?.count || 0;
      stats.emailTemplates = db.prepare("SELECT COUNT(*) as count FROM email_templates").get()?.count || 0;
      stats.emailCampaigns = db.prepare("SELECT COUNT(*) as count FROM email_campaigns").get()?.count || 0;
      stats.emailQueue = db.prepare("SELECT COUNT(*) as count FROM email_queue").get()?.count || 0;
    } catch (e) {
      stats.emailSenders = 0;
      stats.emailTemplates = 0;
      stats.emailCampaigns = 0;
      stats.emailQueue = 0;
    }
  } catch (e) {
    db.close();
    return null;
  }

  db.close();
  return stats;
}

/**
 * Display current database statistics
 */
function displayStats() {
  const stats = getStats();

  if (!stats) {
    log("\n📭 Database file not found or empty.\n", "yellow");
    return;
  }

  log("\n📊 Current Database Statistics:", "cyan");
  log("═".repeat(50), "cyan");
  log(`   Searches:         ${stats.searches}`, "reset");
  log(`   Sites:            ${stats.sites}`, "reset");
  log(`   WordPress Sites:  ${stats.wordpressSites}`, "reset");
  log(`   Contacts:         ${stats.contacts}`, "reset");
  log(`   Keywords:         ${stats.keywords}`, "reset");
  log(`   Executives:       ${stats.executives}`, "reset");
  log("", "reset");
  log("   📧 Email System:", "blue");
  log(`   Senders:          ${stats.emailSenders}`, "reset");
  log(`   Templates:        ${stats.emailTemplates}`, "reset");
  log(`   Campaigns:        ${stats.emailCampaigns}`, "reset");
  log(`   Queue:            ${stats.emailQueue}`, "reset");
  log("═".repeat(50) + "\n", "cyan");
}

/**
 * Clear leads data (sites, contacts, executives, searches)
 */
function clearLeadsData() {
  if (!fs.existsSync(DB_PATH)) {
    log("❌ Database file not found.", "red");
    return false;
  }

  const db = new Database(DB_PATH);

  try {
    // Disable foreign key checks temporarily
    db.pragma('foreign_keys = OFF');
    
    // Clear email_send_log first (references contacts)
    try {
      db.exec("DELETE FROM email_send_log");
    } catch (e) {
      // Table may not exist
    }
    
    // Clear in correct order due to foreign keys
    db.exec("DELETE FROM company_executives");
    db.exec("DELETE FROM contacts");
    db.exec("DELETE FROM sites");
    db.exec("DELETE FROM searches");

    // Reset auto-increment counters
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('company_executives', 'contacts', 'sites', 'searches', 'email_send_log')");
    
    // Re-enable foreign keys
    db.pragma('foreign_keys = ON');

    log("✅ Leads data cleared (sites, contacts, executives, searches)", "green");
    db.close();
    return true;
  } catch (e) {
    log(`❌ Error clearing leads: ${e.message}`, "red");
    db.close();
    return false;
  }
}

/**
 * Clear keywords
 */
function clearKeywords() {
  if (!fs.existsSync(DB_PATH)) {
    log("❌ Database file not found.", "red");
    return false;
  }

  const db = new Database(DB_PATH);

  try {
    db.exec("DELETE FROM keywords");
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'keywords'");
    log("✅ Keywords cleared", "green");
    db.close();
    return true;
  } catch (e) {
    log(`❌ Error clearing keywords: ${e.message}`, "red");
    db.close();
    return false;
  }
}

/**
 * Clear email system data
 */
function clearEmailData() {
  if (!fs.existsSync(DB_PATH)) {
    log("❌ Database file not found.", "red");
    return false;
  }

  const db = new Database(DB_PATH);

  try {
    // Disable foreign key checks temporarily
    db.pragma('foreign_keys = OFF');
    
    // Clear in correct order due to foreign keys
    // email_send_log references contacts and templates
    try {
      db.exec("DELETE FROM email_send_log");
    } catch (e) {
      // Table may not exist
    }
    
    // email_queue references campaigns and senders
    db.exec("DELETE FROM email_queue");
    
    // email_campaigns references templates
    db.exec("DELETE FROM email_campaigns");
    
    // Now safe to delete templates and senders
    db.exec("DELETE FROM email_templates");
    db.exec("DELETE FROM email_senders");
    
    // Also clear settings if user wants fresh start
    try {
      db.exec("DELETE FROM email_settings");
    } catch (e) {
      // Table may not exist
    }
    
    // Reset auto-increment counters
    db.exec("DELETE FROM sqlite_sequence WHERE name LIKE 'email_%'");
    
    // Re-enable foreign keys
    db.pragma('foreign_keys = ON');
    
    log("✅ Email system data cleared (queue, campaigns, templates, senders, logs)", "green");
    db.close();
    return true;
  } catch (e) {
    log(`❌ Error clearing email data: ${e.message}`, "red");
    db.close();
    return false;
  }
}

/**
 * Clear ALL data (keeps table structure)
 */
function clearAllData() {
  // Clear email data FIRST since it references contacts
  clearEmailData();
  clearLeadsData();
  clearKeywords();
  log("\n🧹 All data cleared. Database structure preserved.", "green");
}

/**
 * Delete database file completely (nuclear option)
 */
function deleteDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    log("📭 Database file doesn't exist.", "yellow");
    return true;
  }

  try {
    fs.unlinkSync(DB_PATH);
    log("💥 Database file deleted completely.", "green");
    log("   A fresh database will be created on next server start.", "cyan");
    return true;
  } catch (e) {
    log(`❌ Error deleting database: ${e.message}`, "red");
    return false;
  }
}

/**
 * Prompt for confirmation
 */
async function confirm(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${colors.yellow}${message} (y/N): ${colors.reset}`, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

/**
 * Interactive mode menu
 */
async function interactiveMode() {
  displayStats();

  log("🔧 Database Reset Options:", "cyan");
  log("═".repeat(50), "cyan");
  log("   1. Clear leads data (sites, contacts, executives, searches)", "reset");
  log("   2. Clear keywords only", "reset");
  log("   3. Clear email system data only", "reset");
  log("   4. Clear ALL data (keeps table structure)", "reset");
  log("   5. DELETE database file completely (nuclear)", "red");
  log("   0. Exit without changes", "reset");
  log("═".repeat(50) + "\n", "cyan");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${colors.blue}Enter option (0-5): ${colors.reset}`, async (answer) => {
      rl.close();

      switch (answer.trim()) {
        case "1":
          if (await confirm("Clear all leads data?")) {
            clearLeadsData();
          }
          break;
        case "2":
          if (await confirm("Clear all keywords?")) {
            clearKeywords();
          }
          break;
        case "3":
          if (await confirm("Clear all email system data?")) {
            clearEmailData();
          }
          break;
        case "4":
          if (await confirm("Clear ALL data from the database?")) {
            clearAllData();
          }
          break;
        case "5":
          log("\n⚠️  WARNING: This will completely delete the database file!", "red");
          if (await confirm("Are you absolutely sure?")) {
            deleteDatabase();
          }
          break;
        case "0":
          log("\n👋 Exiting without changes.\n", "cyan");
          break;
        default:
          log("\n❌ Invalid option. Exiting.\n", "red");
      }

      resolve();
    });
  });
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  log("\n🗄️  WordPress Detector - Database Reset Tool", "cyan");
  log("═".repeat(50), "cyan");

  if (args.length === 0) {
    // Interactive mode
    await interactiveMode();
  } else {
    const flag = args[0];

    switch (flag) {
      case "--all":
        displayStats();
        clearAllData();
        break;
      case "--leads":
        displayStats();
        clearLeadsData();
        break;
      case "--email":
        displayStats();
        clearEmailData();
        break;
      case "--keywords":
        displayStats();
        clearKeywords();
        break;
      case "--full":
        displayStats();
        log("\n⚠️  WARNING: This will completely delete the database file!", "red");
        if (await confirm("Are you absolutely sure?")) {
          deleteDatabase();
        }
        break;
      case "--stats":
        displayStats();
        break;
      case "--help":
      case "-h":
        log(`
Usage:
  node reset-db.js                 # Interactive mode
  node reset-db.js --stats         # Show statistics only
  node reset-db.js --all           # Clear all data (keeps tables)
  node reset-db.js --leads         # Clear only leads data
  node reset-db.js --email         # Clear only email system data
  node reset-db.js --keywords      # Clear only keywords
  node reset-db.js --full          # Delete database file completely
        `, "reset");
        break;
      default:
        log(`❌ Unknown flag: ${flag}. Use --help for usage.`, "red");
    }
  }

  log("", "reset");
}

main().catch(console.error);
