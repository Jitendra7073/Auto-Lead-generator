# Email System Documentation

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Database Schema](#database-schema)
4. [Email Queue System](#email-queue-system)
5. [Multi-Sender Round-Robin](#multi-sender-round-robin)
6. [Template System](#template-system)
7. [Follow-Up Automation](#follow-up-automation)
8. [Email Sending Flow](#email-sending-flow)
9. [Configuration](#configuration)

---

## Overview

The outreach system uses a sophisticated queue-based email sending system with:
- **Multi-sender support** with round-robin distribution
- **Per-sender daily limits** and cooldown periods
- **Automated follow-ups** at configurable intervals
- **Template-based emails** with dynamic variable substitution
- **WAL mode** for concurrent database access

---

## Architecture

```
┌─────────────────┐
│   Web UI        │
│  (Prospects)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐       ┌──────────────────┐
│  Email Queue    │──────▶│  Email Service   │
│  (Pending)      │       │  (Processor)     │
└─────────────────┘       └────────┬─────────┘
                                  │
                         ┌────────┴─────────┐
                         │                  │
                    ┌────▼────┐      ┌────▼────┐
                    │ Sender 1│      │ Sender 2│
                    │ (Aradhna)│      │ (Other) │
                    └────┬────┘      └────┬────┘
                         │                  │
                         └────────┬─────────┘
                                  ▼
                          ┌─────────────────┐
                          │   SMTP Server   │
                          │   (Gmail, etc)  │
                          └─────────────────┘
```

---

## Database Schema

### Core Tables

#### 1. `email_queue` - Email Queue
Stores emails waiting to be sent or already sent.

```sql
CREATE TABLE email_queue (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER,                    -- Brand this email belongs to
  lead_id INTEGER,                     -- For general leads
  blog_lead_id INTEGER,                -- For blog leads
  email_id INTEGER,                    -- Email to send to (general)
  blog_email_id INTEGER,               -- Email to send to (blog)
  template_id INTEGER,                 -- Template used
  sender_email TEXT,                   -- Selected sender email
  to_email TEXT NOT NULL,              -- Recipient email
  subject TEXT,                        -- Email subject
  body TEXT,                          -- Email body (HTML)
  email_category TEXT,                 -- main, followup_1, followup_2, etc.
  sequence_number INTEGER,             -- 0 for main, 1+ for followups
  parent_log_id INTEGER,               -- ID of main email for followups
  status TEXT DEFAULT 'pending',       -- pending, sending, sent, failed
  scheduled_for DATETIME,              -- When to send
  scheduled_at DATETIME,               -- When queued
  sent_at DATETIME,                    -- Actually sent time
  error_message TEXT,                  -- Error if failed
  attempts INTEGER DEFAULT 0,          -- Number of send attempts
  message_id TEXT,                     -- SMTP message ID
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  CHECK (lead_id IS NOT NULL OR blog_lead_id IS NOT NULL),
  CHECK (email_id IS NOT NULL OR blog_email_id IS NOT NULL)
);
```

#### 2. `brand_sender_emails` - Multi-Sender Configuration
Stores SMTP credentials for each sender email per brand.

```sql
CREATE TABLE brand_sender_emails (
  id INTEGER PRIMARY KEY,
  brand_id INTEGER NOT NULL,
  email TEXT NOT NULL,                 -- Sender email address
  from_name TEXT,                     -- Display name (e.g., "Aradhna")
  smtp_host TEXT,                     -- SMTP server (e.g., smtp.gmail.com)
  smtp_port INTEGER DEFAULT 587,      -- SMTP port
  smtp_secure INTEGER DEFAULT 0,      -- SSL/TLS (1) or not (0)
  smtp_user TEXT,                     -- SMTP username
  smtp_password TEXT,                 -- SMTP password/app password
  is_active INTEGER DEFAULT 1,        -- Active or not
  daily_limit INTEGER DEFAULT 20,     -- Max emails per day
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  UNIQUE (brand_id, email),
  FOREIGN KEY (brand_id) REFERENCES brands(id)
);
```

#### 3. `email_templates` - Email Templates
Stores reusable email templates with variables.

```sql
CREATE TABLE email_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,              -- Email subject line
  body TEXT NOT NULL,                 -- Email body (HTML with {{variables}})
  variables TEXT,                     -- List of variables used
  email_category TEXT DEFAULT 'main', -- main, followup_1, followup_2, etc.
  sequence_number INTEGER DEFAULT 0,
  template_type TEXT DEFAULT 'general', -- general or blog
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### 4. `outreach_logs` - Sent Email History
Logs of all sent emails for tracking.

```sql
CREATE TABLE outreach_logs (
  id INTEGER PRIMARY KEY,
  lead_id INTEGER,                    -- For general leads
  blog_lead_id INTEGER,               -- For blog leads
  asset_id INTEGER,                   -- Campaign asset referenced
  email_id INTEGER,                   -- Email used (general)
  blog_email_id INTEGER,              -- Email used (blog)
  email_category TEXT,                -- main, followup_1, etc.
  sequence_number INTEGER DEFAULT 0,
  parent_log_id INTEGER,              -- Main email ID for followups
  status TEXT DEFAULT 'SENT',         -- SENT, OPENED, REPLIED, REJECTED
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sender_email TEXT,                  -- Which sender sent this

  FOREIGN KEY (lead_id) REFERENCES leads(id),
  FOREIGN KEY (blog_lead_id) REFERENCES blog_leads(id),
  FOREIGN KEY (parent_log_id) REFERENCES outreach_logs(id)
);
```

---

## Email Queue System

### Adding Emails to Queue

Emails are added to the queue from multiple sources:

#### 1. Manual Send from Web UI
```javascript
// From src/api/routes/settings.js
POST /api/leads/:id/send-email
```

#### 2. Programmatic Send
```javascript
// From src/services/TemplateService.js
EmailQueueRepo.addToQueue({
  brand_id: brandId,
  lead_id: leadId,
  blog_lead_id: blogLeadId,
  email_id: emailId,
  blog_email_id: blogEmailId,
  template_id: templateId,
  to_email: toEmail,
  subject: renderedSubject,
  body: renderedBody,
  email_category: 'main',
  sequence_number: 0,
  scheduled_for: new Date()
});
```

#### 3. Follow-Up Automation
```javascript
// From src/services/FollowUpService.js
// Automatically schedules follow-ups when main email is sent
static async scheduleFollowUps(logId, leadId, blogLeadId, emailId, blogEmailId, brandId)
```

---

## Multi-Sender Round-Robin

### Sender Selection Algorithm

The system uses a **round-robin with cooldown** approach to distribute emails across multiple senders.

#### Sender Status Tracking
```javascript
// From EmailService.js line 422-671
static async processQueue() {
  // Get all active senders with their SMTP credentials
  const senders = this.getAllActiveSenders(); // From brand_sender_emails table

  // Check each sender's status
  const senderStatus = {};
  for (const sender of senders) {
    const lastSent = this.getLastSentTime(sender.email);
    const cooldownEnd = lastSent + SENDER_COOLDOWN_MIN;
    const ready = Date.now() >= cooldownEnd;

    senderStatus[sender.email] = {
      sender,
      lastSent,
      cooldownUntil: cooldownEnd,
      ready: ready,
      emailsSent: 0
    };
  }

  // Select first available sender
  const selectedSender = senders.find(s => senderStatus[s.email].ready);
}
```

#### Cooldown Configuration

```javascript
// From EmailService.js
static SENDER_COOLDOWN_MIN = 10 * 60 * 1000;      // 10 minutes minimum
static SENDER_COOLDOWN_RANDOM = 3 * 60 * 1000;    // 0-3 minutes random
static BETWEEN_EMAIL_DELAY = 60 * 1000;           // 1 minute between emails
```

**Total delay per sender: 10-13 minutes cooldown + 1 minute between emails**

#### Daily Limits

Each sender has a `daily_limit` (default 20) stored in `brand_sender_emails`. The system checks:

```javascript
// Count emails sent today by this sender
const sentToday = db.prepare(`
  SELECT COUNT(*) as count
  FROM outreach_logs
  WHERE sender_email = ?
    AND DATE(sent_at) = DATE('now')
`).get(senderEmail).count;

if (sentToday >= sender.daily_limit) {
  // Skip this sender, limit reached
}
```

---

## Template System

### Variable Substitution

Templates use `{{variable}}` placeholders that get replaced with actual data.

#### Available Variables

| Variable | Blog Leads | General Leads | Description |
|----------|------------|---------------|-------------|
| `{{name}}` | Sender's name | Sender's name | Display name of sender |
| `{{company}}` | Their article URL | Company name | Prospect's company/article |
| `{{campaign}}` | Your campaign name (link) | Your campaign name (link) | Linked to your content |
| `{{domain}}` | Their domain | Their domain | Website domain |
| `{{email}}` | Their email | Their email | Recipient email |
| `{{brand}}` | Brand name | Brand name | Your brand name |

#### Blog Lead Variables Example

**Template:**
```html
Hi {{domain}} Team,

I found your article on {{company}} via Google.

We recently wrote a detailed guide on {{campaign}}.

Best,
{{name}}
```

**Rendered Output:**
```html
Hi agentestudio Team,

I found your article on https://agentestudio.com/blog/e-learning-platform via Google.

We recently wrote a detailed guide on <a href="https://www.enacton.com/blog/how-to-create-an-lms/">How To Create An Lms</a>.

Best,
Aradhna
```

#### Template Rendering Process

```javascript
// From TemplateService.js
static prepareEmail(templateId, leadId, emailId) {
  // 1. Get template
  const template = this.getTemplate(templateId);

  // 2. Fetch lead data from database
  const leadData = db.prepare(`
    SELECT
      bl.id as lead_id,
      bp.article_title,
      bp.article_url,
      bp.domain,
      be.email as to_email,
      c.name as campaign_name,
      c.target_url,
      b.name as brand_name
    FROM blog_leads bl
    JOIN blog_prospects bp ON bl.blog_prospect_id = bp.id
    JOIN blog_emails be ON be.id = ?
    JOIN campaigns c ON bl.campaign_id = c.id
    JOIN brands b ON c.brand_id = b.id
    WHERE bl.id = ?
  `).get(emailId, leadId);

  // 3. Render template with variables
  const { subject, body } = this.renderTemplate(template, leadData);

  // 4. Return for queue
  return {
    to_email: leadData.to_email,
    subject,
    body,
    email_category: template.email_category,
    sequence_number: template.sequence_number
  };
}
```

---

## Follow-Up Automation

### Configuration

Follow-up intervals are stored in `system_settings` table:

| Setting | Default | Description |
|---------|---------|-------------|
| `followup_1_interval_days` | 3 | Days after main email |
| `followup_2_interval_days` | 7 | Days after main email |
| `followup_3_interval_days` | 14 | Days after main email |
| `followup_4_interval_days` | 21 | Days after main email |
| `auto_schedule_followups` | false | Automatically schedule follow-ups |

### Follow-Up Scheduling Process

```javascript
// From FollowUpService.js
static async scheduleFollowUps(logId, leadId, blogLeadId, emailId, blogEmailId, brandId) {
  // Get all follow-up templates
  const templates = db.prepare(`
    SELECT id, email_category, sequence_number
    FROM email_templates
    WHERE email_category IN ('followup_1', 'followup_2', 'followup_3', 'followup_4')
  `).all();

  // Get schedule settings
  const schedule = this.getScheduleFromDB();

  // Schedule each follow-up
  for (const template of templates) {
    const delayDays = schedule[template.email_category] || 7;
    const scheduledDate = new Date();
    scheduledDate.setDate(scheduledDate.getDate() + delayDays);

    // Add to queue
    EmailQueueRepo.addToQueue({
      lead_id: leadId,
      blog_lead_id: blogLeadId,
      email_id: emailId,
      blog_email_id: blogEmailId,
      template_id: template.id,
      email_category: template.email_category,
      sequence_number: template.sequence_number,
      parent_log_id: logId,  // Link to main email
      scheduled_for: scheduledDate
    });
  }
}
```

### Follow-Up Chain

```
Main Email (Day 0)
    │
    ├─ Follow-up 1 (Day 3)
    │   │
    │   └─ Follow-up 2 (Day 7)
    │       │
    │       └─ Follow-up 3 (Day 14)
    │           │
    │           └─ Follow-up 4 (Day 21)
```

---

## Email Sending Flow

### Complete Flow Diagram

```
1. USER ACTION
   User clicks "Send Email" from Web UI
   │
   ▼
2. PREPARE EMAIL
   - Fetch template
   - Fetch lead data (prospect, email, campaign)
   - Render template with variables
   │
   ▼
3. ADD TO QUEUE
   - Insert into email_queue table
   - Status: 'pending'
   │
   ▼
4. EMAIL SERVICE PROCESSOR
   - Runs every minute (cron-like)
   - Fetches pending emails from queue
   │
   ▼
5. SENDER SELECTION
   - Get all active senders
   - Check cooldown status
   - Check daily limits
   - Select first available sender
   │
   ▼
6. SEND EMAIL
   - Create SMTP transporter
   - Send via nodemailer
   - Handle success/failure
   │
   ├─ SUCCESS:               ┌─ FAILURE:
   │   │                      │
   │   ▼                      ▼
   │ Update queue             Update queue
   │   status = 'sent'        status = 'failed'
   │   sent_at = now          error_message = error
   │   message_id = SMTP ID   attempts++
   │                          │
   │   ▼                      ▼
   │ Log to outreach_logs    Retry later (max 3 attempts)
   │   │
   │   ▼
   │ Schedule follow-ups (if enabled)
   │
   ▼
8. COOLDOWN
   - Set sender cooldown: 10-13 min
   - Wait 1 minute before next email
```

### Detailed Sending Process

```javascript
// From EmailService.js sendQueuedEmail()
static async sendQueuedEmail(queueItem) {
  // 1. Mark as sending
  EmailQueueRepo.markAsSending(queueItem.id);

  // 2. Re-render template (variables are fresh)
  const rendered = TemplateService.renderTemplate(
    { subject: queueItem.subject, body: queueItem.body },
    queueItem  // Contains all lead data
  );

  // 3. Replace {{name}} with actual sender's from_name
  const fromName = queueItem.sender_from_name || queueItem.smtp_from_name;
  if (fromName && fromName !== "Outreach Team") {
    rendered.body = rendered.body.replace(/\{\{name\}\}/gi, fromName);
    rendered.subject = rendered.subject.replace(/\{\{name\}\}/gi, fromName);
  }

  // 4. Prepare SMTP config
  const brandConfig = {
    smtp_host: queueItem.smtp_host,
    smtp_port: queueItem.smtp_port,
    smtp_secure: queueItem.smtp_secure,
    smtp_user: queueItem.smtp_user,
    smtp_password: queueItem.smtp_password,
    smtp_from_name: fromName,
    smtp_from_email: queueItem.sender_email || queueItem.smtp_from_email,
  };

  // 5. Send email
  const result = await this.sendEmailWithBrand(
    queueItem.to_email,
    rendered.subject,
    rendered.body,
    brandConfig
  );

  // 6. Handle result
  if (result.success) {
    EmailQueueRepo.markAsSent(queueItem.id, result.messageId);
    this.logOutreach(queueItem, result.messageId);
    this.scheduleFollowUpsIfNeeded(queueItem);
  } else {
    EmailQueueRepo.markAsFailed(queueItem.id, result.error);
  }

  return result;
}
```

---

## Configuration

### System Settings

Settings stored in `system_settings` table:

```sql
-- Daily limits
INSERT INTO system_settings (key, value, description) VALUES
  ('daily_prospect_limit', '10', 'Max prospects per day'),
  ('daily_email_limit', '50', 'Max emails to extract per day'),
  ('daily_outreach_limit', '20', 'Max outreach emails per day');

-- Follow-up intervals
INSERT INTO system_settings (key, value, description) VALUES
  ('followup_1_interval_days', '3', 'Days until follow-up #1'),
  ('followup_2_interval_days', '7', 'Days until follow-up #2'),
  ('followup_3_interval_days', '14', 'Days until follow-up #3'),
  ('followup_4_interval_days', '21', 'Days until follow-up #4'),
  ('auto_schedule_followups', 'false', 'Auto-schedule follow-ups');
```

### Adding Sender Emails

Via SQL:
```sql
INSERT INTO brand_sender_emails (
  brand_id,
  email,
  from_name,
  smtp_host,
  smtp_port,
  smtp_secure,
  smtp_user,
  smtp_password,
  daily_limit
) VALUES (
  1,                                    -- brand_id
  'aradhanasingh.enacton@gmail.com',    -- email
  'Aradhna',                            -- from_name
  'smtp.gmail.com',                     -- smtp_host
  587,                                  -- smtp_port
  0,                                    -- smtp_secure (0 = TLS)
  'aradhanasingh.enacton@gmail.com',    -- smtp_user
  'app_password_here',                  -- smtp_password (use app password!)
  20                                    -- daily_limit
);
```

Via Web UI:
1. Go to **Settings** → **Brands**
2. Click on a brand
3. Add sender email with SMTP credentials

---

## Important Notes

### Gmail App Passwords

For Gmail accounts, you **must use App Passwords**, not the regular password:

1. Go to Google Account → Security
2. Enable 2-Factor Authentication
3. Generate App Password
4. Use app password in `smtp_password` field

### Database WAL Mode

The system uses SQLite in WAL (Write-Ahead Logging) mode for concurrent access:

```javascript
db.pragma("journal_mode = WAL");
```

This allows the web server and email processor to access the database simultaneously.

### Cooldown Management

Sender cooldown is tracked in memory and in the database via `outreach_logs.sent_at`:

```javascript
// Get last sent time
const lastSentLog = db.prepare(`
  SELECT MAX(sent_at) as last_sent
  FROM outreach_logs
  WHERE sender_email = ?
`).get(senderEmail);

const lastSent = lastSentLog?.last_sent
  ? new Date(lastSentLog.last_sent).getTime()
  : 0;
```

---

## File Locations

| Component | File Path |
|-----------|-----------|
| Email Queue Repository | `src/repositories/EmailQueueRepo.js` |
| Email Service | `src/services/EmailService.js` |
| Template Service | `src/services/TemplateService.js` |
| Follow-Up Service | `src/services/FollowUpService.js` |
| Database Schema | `src/database/db.js` |
| Email Templates | Default templates in `db.js`, custom in `email_templates` table |
| Settings Routes | `src/api/routes/settings.js` |

---

## Troubleshooting

### Emails Not Sending

1. **Check queue status:**
   ```sql
   SELECT status, COUNT(*)
   FROM email_queue
   GROUP BY status;
   ```

2. **Check for errors:**
   ```sql
   SELECT * FROM email_queue
   WHERE status = 'failed'
   ORDER BY created_at DESC
   LIMIT 10;
   ```

3. **Check sender availability:**
   ```sql
   SELECT
     bse.email,
     bse.from_name,
     bse.is_active,
     COUNT(ol.id) as emails_sent_today
   FROM brand_sender_emails bse
   LEFT JOIN outreach_logs ol ON ol.sender_email = bse.email
     AND DATE(ol.sent_at) = DATE('now')
   GROUP BY bse.email;
   ```

### SMTP Configuration Issues

1. **Verify SMTP settings** are correct
2. **Use App Passwords** for Gmail
3. **Check port:** 587 for TLS, 465 for SSL
4. **Test SMTP** manually:
   ```javascript
   // Test from command line
   node -e "
     import('nodemailer').then(async ({createTransport}) => {
       const transporter = createTransport({
         host: 'smtp.gmail.com',
         port: 587,
         secure: false,
         auth: {
           user: 'your@gmail.com',
           pass: 'app_password'
         }
       });
       const result = await transporter.sendMail({
         from: 'your@gmail.com',
         to: 'test@example.com',
         subject: 'Test',
         text: 'Test email'
       });
       console.log('Sent:', result.messageId);
     });
   "
   ```

### Variable Not Replacing

1. **Check variable name** in template matches available variables
2. **Check lead data** is being fetched correctly
3. **Check isBlogLead detection** for correct variable mapping
4. **Verify sender_from_name** is available in queue item

---

## Best Practices

1. **Use multiple sender emails** to distribute load
2. **Set appropriate daily limits** (15-20 per sender for Gmail)
3. **Respect cooldown periods** (10-13 min between sends per sender)
4. **Use follow-ups strategically** (don't overdo it)
5. **Monitor sender reputation** (check spam folders)
6. **Test templates** before bulk sending
7. **Keep email copy personalized** and relevant
8. **Honor unsubscribe requests** immediately

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/queue` | GET | Get all queued emails |
| `/api/queue/process` | POST | Manually trigger queue processing |
| `/api/scripts/status` | GET | Get running script status |
| `/api/settings/brands/:id/sender-emails` | POST | Add sender email to brand |
| `/api/leads/:id/send-email` | POST | Send email to lead |
| `/api/email-templates` | GET | Get all templates |
| `/api/email-templates/:id` | GET | Get template by ID |

---

## Cron/Scheduler Setup

The system needs a cron job or scheduler to process the email queue. Example with node-cron:

```javascript
// In your main server.js
import cron from 'node-cron';
import { EmailService } from './services/EmailService.js';

// Process queue every minute
cron.schedule('* * * * *', async () => {
  console.log('Processing email queue...');
  await EmailService.processQueue();
});
```

Or use an external cron job:
```bash
# Crontab entry
* * * * * cd /path/to/outreach && node run-outreach.js --mode=process-queue
```

---

End of Documentation
