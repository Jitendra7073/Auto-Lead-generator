const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "wordpress-detector.db");
const db = new Database(DB_PATH);

console.log("--- Triggering Auto AI Verification ---");

// Enqueue all sites that are marked as WordPress but haven't been successfully classified by AI yet.
const result = db
  .prepare(
    `
    UPDATE sites 
    SET ai_status = 'pending'
    WHERE is_wordpress = 1 
      AND text_content IS NOT NULL 
      AND text_content != ''
      AND (ai_status != 'completed' OR ai_is_wordpress IS NULL OR ai_is_genuine_match IS NULL)
`,
  )
  .run();

console.log(
  `✅ Queued ${result.changes} "Unverified WP" sites for AI processing.`,
);
db.close();
