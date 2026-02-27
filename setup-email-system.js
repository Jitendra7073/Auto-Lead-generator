const Database = require('better-sqlite3');
const path = require('path');

// Initialize database
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

console.log('🔧 Setting up Email System tables...\n');

// ============================================
// EMAIL SENDERS TABLE
// ============================================
db.exec(`
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

console.log('✅ Email Senders table created');

// ============================================
// EMAIL TEMPLATES TABLE
// ============================================
db.exec(`
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

console.log('✅ Email Templates table created');

// ============================================
// EMAIL CAMPAIGNS TABLE
// ============================================
db.exec(`
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

console.log('✅ Email Campaigns table created');

// ============================================
// EMAIL QUEUE TABLE
// ============================================
db.exec(`
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES email_campaigns(id),
    FOREIGN KEY (sender_id) REFERENCES email_senders(id)
  )
`);

console.log('✅ Email Queue table created');

// ============================================
// INSERT SAMPLE TEMPLATES
// ============================================

const sampleTemplates = [
  {
    name: 'Welcome Email',
    subject: 'Welcome to {{company}}!',
    category: 'welcome',
    description: 'Basic welcome email for new contacts',
    html_content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #2563eb; color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { padding: 30px; background: #f9fafb; border-radius: 0 0 8px 8px; }
    .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Welcome {{name}}!</h1>
    </div>
    <div class="content">
      <p>Hello {{name}},</p>
      <p>Thank you for your interest in {{company}}. We're excited to connect with you!</p>
      <p>We visited your website at {{site}} and were impressed by what you're building.</p>
      <p>Let's explore how we can work together.</p>
      <p>Best regards,<br>Your Name</p>
    </div>
    <div class="footer">
      <p>This email was sent to {{email}}</p>
    </div>
  </div>
</body>
</html>`,
    text_content: `Hello {{name}},

Thank you for your interest in {{company}}. We're excited to connect with you!

We visited your website at {{site}} and were impressed by what you're building.

Let's explore how we can work together.

Best regards,
Your Name

---
This email was sent to {{email}}`
  },
  {
    name: 'Cold Outreach - Partnership',
    subject: 'Partnership Opportunity with {{company}}',
    category: 'outreach',
    description: 'Cold outreach for potential partnerships',
    html_content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
    .content { padding: 30px; background: #f9fafb; }
    .cta { display: inline-block; padding: 12px 24px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Partnership Opportunity</h1>
    </div>
    <div class="content">
      <p>Hi {{name}},</p>
      <p>I came across {{site}} and was really impressed by what {{company}} is building.</p>
      <p>I believe there could be a great synergy between our organizations.</p>
      <p>Would you be open to a quick 15-minute call to explore potential collaboration?</p>
      <a href="mailto:{{email}}" class="cta">Schedule a Call</a>
      <p>I look forward to hearing from you!</p>
      <p>Best regards,<br>Your Name<br>Your Company<br>your-email@example.com</p>
    </div>
  </div>
</body>
</html>`,
    text_content: `Hi {{name}},

I came across {{site}} and was really impressed by what {{company}} is building.

I believe there could be a great synergy between our organizations.

Would you be open to a quick 15-minute call to explore potential collaboration?

I look forward to hearing from you!

Best regards,
Your Name
Your Company
your-email@example.com`
  },
  {
    name: 'Follow-Up Email',
    subject: 'Following up on my previous email',
    category: 'followup',
    description: 'Follow-up email for non-responders',
    html_content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .content { padding: 30px; background: #f9fafb; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="content">
      <p>Hi {{name}},</p>
      <p>I wanted to quickly follow up on my previous email regarding {{company}}.</p>
      <p>I understand you're busy, but I believe there's a great opportunity for us to collaborate.</p>
      <p>Would you have 5 minutes this week to chat?</p>
      <p>No pressure at all - just thought I'd reach out one more time.</p>
      <p>Best,<br>Your Name</p>
    </div>
  </div>
</body>
</html>`,
    text_content: `Hi {{name}},

I wanted to quickly follow up on my previous email regarding {{company}}.

I understand you're busy, but I believe there's a great opportunity for us to collaborate.

Would you have 5 minutes this week to chat?

No pressure at all - just thought I'd reach out one more time.

Best,
Your Name`
  }
];

// Insert sample templates
const insertTemplate = db.prepare(`
  INSERT INTO email_templates (name, subject, html_content, text_content, description, category)
  VALUES (?, ?, ?, ?, ?, ?)
`);

sampleTemplates.forEach(template => {
  try {
    insertTemplate.run(
      template.name,
      template.subject,
      template.html_content,
      template.text_content,
      template.description,
      template.category
    );
    console.log(`✅ Added sample template: ${template.name}`);
  } catch (error) {
    if (error.message.includes('UNIQUE')) {
      console.log(`⏭️  Template already exists: ${template.name}`);
    }
  }
});

console.log('\n🎉 Setup complete!');
console.log('\n📋 Next steps:');
console.log('1. Start your server: npm run server');
console.log('2. Open: http://localhost:3001/email-manager.html');
console.log('3. Add your email sender accounts');
console.log('4. Customize or create email templates');
console.log('5. Create your first campaign!\n');

// Sample sender data (DO NOT use these - add your own)
console.log('📮 Sample Email Senders Configuration:');
console.log('\nFor Gmail:');
console.log('  - Enable 2-factor authentication');
console.log('  - Generate App Password');
console.log('  - Use App Password (not regular password)');
console.log('\nRecommended: 5 Gmail accounts for round-robin');
console.log('  - Each account: 500 emails/day limit');
console.log('  - Total capacity: 2,500 emails/day\n');

db.close();
