const nodemailer = require("nodemailer");
const db = require("./database");

/**
 * Email Queue Worker
 * Processes emails from the queue using round-robin distribution
 */

class EmailQueueWorker {
  constructor() {
    this.isProcessing = false;
    this.currentSenderIndex = 0;
    this.emailsSentInCycle = 0;
    this.checkInterval = null;
    this.isPaused = false;
  }

  /**
   * Start the queue worker
   */
  start() {
    if (this.isProcessing) {
      console.log("⚠️  Worker already running");
      return;
    }

    this.isProcessing = true;
    console.log("🚀 Email Queue Worker started");

    // Process immediately
    this.processQueue();

    // Check every 30 seconds for new emails
    this.checkInterval = setInterval(() => {
      if (!this.isProcessing && !this.isPaused) {
        this.isProcessing = true;
        this.processQueue();
      }
    }, 30000);
  }

  /**
   * Stop the queue worker
   */
  stop() {
    this.isProcessing = false;
    this.isPaused = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log("⏸️  Email Queue Worker stopped");
  }

  /**
   * Pause processing (keeps worker alive but stops picking new items)
   */
  pause() {
    this.isPaused = true;
    this.isProcessing = false;
    console.log("⏸️  Queue processing paused");
  }

  /**
   * Resume processing after pause
   */
  resume() {
    if (this.isPaused) {
      this.isPaused = false;
      this.isProcessing = true;
      this.processQueue();
      console.log("▶️  Queue processing resumed");
    }
  }

  /**
   * Trigger immediate queue processing (called from API when user clicks Start Queue)
   */
  triggerNow() {
    if (this.isPaused) {
      this.isPaused = false;
    }
    this.isProcessing = true;

    // Clear any existing check interval and restart it
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
    this.checkInterval = setInterval(() => {
      if (!this.isProcessing && !this.isPaused) {
        this.isProcessing = true;
        this.processQueue();
      }
    }, 30000);

    // Process immediately
    this.processQueue();
    console.log("🚀 Queue processing triggered immediately!");
    return { success: true, message: "Queue processing started immediately" };
  }

  /**
   * Get active sender accounts
   */
  getActiveSenders() {
    const senders = db.all(`
      SELECT * FROM email_senders
      WHERE is_active = 1
      ORDER BY created_at ASC
    `);
    return senders;
  }

  /**
   * Reset daily counters if needed
   */
  checkDailyReset() {
    const today = new Date().toDateString();

    db.all("SELECT * FROM email_senders").forEach((sender) => {
      if (sender.last_reset_date !== today) {
        db.run(
          `
          UPDATE email_senders
          SET sent_today = 0,
              last_reset_date = ?
          WHERE id = ?
        `,
          [today, sender.id],
        );
        console.log(`🔄 Reset daily counter for: ${sender.name}`);
      }
    });
  }

  /**
   * Get next email from queue
   */
  getNextEmail() {
    return db.get(
      `
      SELECT * FROM email_queue
      WHERE status = 'queued'
        AND (scheduled_at IS NULL OR scheduled_at <= ?)
      ORDER BY created_at ASC
      LIMIT 1
    `,
      [new Date().toISOString()],
    );
  }

  /**
   * Get next sender in round-robin
   */
  getNextSender() {
    const senders = this.getActiveSenders();

    if (senders.length === 0) {
      console.error("❌ No active email senders found!");
      return null;
    }

    // Find next available sender (under daily limit)
    let attempts = 0;
    const maxAttempts = senders.length;

    while (attempts < maxAttempts) {
      const sender = senders[this.currentSenderIndex];

      if (sender.sent_today < sender.daily_limit) {
        this.currentSenderIndex =
          (this.currentSenderIndex + 1) % senders.length;
        return sender;
      }

      console.log(
        `⚠️  ${sender.name} has reached daily limit (${sender.sent_today}/${sender.daily_limit})`,
      );
      this.currentSenderIndex = (this.currentSenderIndex + 1) % senders.length;
      attempts++;
    }

    console.warn("⚠️  All senders have reached daily limit!");
    return null;
  }

  /**
   * Send email
   */
  async sendEmail(sender, emailData) {
    let transporter;

    try {
      // Create transporter
      if (sender.service === "custom") {
        transporter = nodemailer.createTransport({
          host: sender.smtp_host,
          port: sender.smtp_port,
          secure: sender.smtp_port === 465,
          auth: {
            user: sender.email,
            pass: sender.password,
          },
        });
      } else {
        transporter = nodemailer.createTransport({
          service: sender.service,
          auth: {
            user: sender.email,
            pass: sender.password,
          },
        });
      }

      // Send email
      const mailOptions = {
        from: sender.email,
        to: emailData.recipient_email,
        subject: emailData.subject,
        html: emailData.html_content,
        text: emailData.text_content,
      };

      const info = await transporter.sendMail(mailOptions);

      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Process the email queue
   */
  async processQueue() {
    if (!this.isProcessing) return;

    // Check daily reset
    this.checkDailyReset();

    // Get next email
    const email = this.getNextEmail();

    if (!email) {
      // No emails to process (or no scheduled ones ready)
      this.isProcessing = false;
      return;
    }

    console.log("\n📧 Processing email...");
    console.log(`   To: ${email.recipient_email}`);
    console.log(`   Subject: ${email.subject}`);

    // Get next sender
    const sender = this.getNextSender();

    if (!sender) {
      console.log("⏸️  All senders at daily limit. Waiting...");
      this.isProcessing = false;
      return;
    }

    console.log(`   From: ${sender.name} (${sender.email})`);

    // Send the email
    const result = await this.sendEmail(sender, email);

    if (result.success) {
      // Update queue item
      db.run(
        `
        UPDATE email_queue
        SET status = 'sent',
            sender_id = ?,
            sent_at = CURRENT_TIMESTAMP,
            attempts = attempts + 1
        WHERE id = ?
      `,
        [sender.id, email.id],
      );

      // Update sender counter
      db.run(
        `
        UPDATE email_senders
        SET sent_today = sent_today + 1
        WHERE id = ?
      `,
        [sender.id],
      );

      // Update campaign counter
      if (email.campaign_id) {
        db.run(
          `
          UPDATE email_campaigns
          SET sent_count = sent_count + 1
          WHERE id = ?
        `,
          [email.campaign_id],
        );
      }

      console.log("✅ Email sent successfully!");
      this.emailsSentInCycle++;
    } else {
      // Update queue item with error
      const newAttempts = (email.attempts || 0) + 1;

      if (newAttempts >= 3) {
        db.run(
          `
          UPDATE email_queue
          SET status = 'failed',
              error_message = ?,
              attempts = ?
          WHERE id = ?
        `,
          [result.error, newAttempts, email.id],
        );

        // Update campaign counter
        if (email.campaign_id) {
          db.run(
            `
            UPDATE email_campaigns
            SET failed_count = failed_count + 1
            WHERE id = ?
          `,
            [email.campaign_id],
          );
        }

        console.error(`💀 Email failed after 3 attempts: ${result.error}`);
      } else {
        db.run(
          `
          UPDATE email_queue
          SET attempts = ?,
              error_message = ?
          WHERE id = ?
        `,
          [newAttempts, result.error, email.id],
        );

        console.error(
          `❌ Email failed (attempt ${newAttempts}/3): ${result.error}`,
        );
      }
    }

    // Check if we completed a cycle
    const activeSenders = this.getActiveSenders();
    if (this.emailsSentInCycle >= activeSenders.length) {
      await this.completeCycle();
    }

    // Wait before next email
    if (this.isProcessing) {
      const delay = this.calculateDelay();
      const delayMinutes = Math.ceil(delay / 60000);

      console.log(`⏰ Waiting ${delayMinutes} minutes before next email...\n`);

      await this.sleep(delay);

      // Process next email
      if (this.isProcessing) {
        this.processQueue();
      }
    }
  }

  /**
   * Complete a full cycle
   */
  async completeCycle() {
    console.log("\n🎉 Full cycle complete!");
    console.log(
      `📊 Sent ${this.emailsSentInCycle} emails using ${
        this.getActiveSenders().length
      } senders`,
    );

    this.emailsSentInCycle = 0;
  }

  /**
   * Get queue settings from database
   */
  getSettings() {
    try {
      const rows = db.all("SELECT key, value FROM email_settings");
      const settings = {};
      rows.forEach((r) => {
        settings[r.key] = parseFloat(r.value);
      });
      return {
        perEmailDelay: (settings.per_email_delay || 60) * 1000, // convert to ms
        cycleCooldownMin: (settings.cycle_cooldown_min || 10) * 60 * 1000, // convert to ms
        cycleCooldownMax: (settings.cycle_cooldown_max || 13) * 60 * 1000, // convert to ms
      };
    } catch (e) {
      // Fallback to defaults if DB read fails
      return {
        perEmailDelay: 60 * 1000,
        cycleCooldownMin: 10 * 60 * 1000,
        cycleCooldownMax: 13 * 60 * 1000,
      };
    }
  }

  /**
   * Calculate delay before next email (reads from DB settings)
   */
  calculateDelay() {
    const settings = this.getSettings();

    // If we just completed a cycle, use cooldown
    if (this.emailsSentInCycle === 0) {
      const range = settings.cycleCooldownMax - settings.cycleCooldownMin;
      const randomDelay = Math.floor(Math.random() * range);
      return settings.cycleCooldownMin + randomDelay;
    }

    // Standard delay between emails
    return settings.perEmailDelay;
  }

  /**
   * Get queue statistics
   */
  getStats() {
    const senders = this.getActiveSenders();

    return {
      queue: {
        total: db.all(
          'SELECT COUNT(*) as count FROM email_queue WHERE status = "queued"',
        )[0].count,
        isProcessing: this.isProcessing,
      },
      sent: {
        total: db.all(
          'SELECT COUNT(*) as count FROM email_queue WHERE status = "sent"',
        )[0].count,
        today: senders.reduce((sum, s) => sum + s.sent_today, 0),
      },
      failed: db.all(
        'SELECT COUNT(*) as count FROM email_queue WHERE status = "failed"',
      )[0].count,
      cycles: {
        completed: Math.floor(
          db.all(
            'SELECT COUNT(*) as count FROM email_queue WHERE status = "sent"',
          )[0].count / senders.length,
        ),
      },
      accounts: senders.map((s) => ({
        id: s.id,
        name: s.name,
        sentToday: s.sent_today,
        dailyLimit: s.daily_limit,
      })),
      status: {
        isProcessing: this.isProcessing,
        isPaused: this.isPaused,
        currentAccountIndex: this.currentSenderIndex,
        scheduledItemsCount: db.all(
          'SELECT COUNT(*) as count FROM email_queue WHERE status = "queued" AND scheduled_at IS NOT NULL AND scheduled_at > CURRENT_TIMESTAMP',
        )[0].count,
      },
    };
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton
const worker = new EmailQueueWorker();

module.exports = worker;
