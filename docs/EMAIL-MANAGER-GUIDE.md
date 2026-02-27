# 📧 Complete Email Manager System

A fully manageable email system with CRUD operations for email senders and templates, with toggle functionality and round-robin distribution.

## 🎯 What You Can Do

### **✅ Email Senders Management**
- **Create** - Add new email accounts (Gmail, Outlook, Custom SMTP)
- **Read** - View all senders with their status and daily limits
- **Update** - Edit sender details (name, password, daily limit)
- **Delete** - Remove sender accounts
- **Toggle** - Enable/disable senders (only active senders are used)

### **✅ Email Templates Management**
- **Create** - Design HTML email templates with placeholders
- **Read** - View all templates organized by category
- **Update** - Edit template content and settings
- **Delete** - Remove unused templates
- **Toggle** - Enable/disable templates
- **Preview** - See how your template looks with test data

### **✅ Campaign Management**
- Create campaigns using any active template
- Choose target recipients (All, WordPress only, Executives)
- Track sent/failed counts
- Real-time status updates

---

## 🚀 Quick Start

### **1. Add the API Routes to Your Server**

Add this to your `server.js`:

```javascript
const emailRouter = require('./email-senders-templates-api');

// Mount the email routes
app.use('/api/email', emailRouter);
```

### **2. Access the Email Manager**

Open in browser:
```
http://localhost:3001/email-manager.html
```

---

## 📮 Managing Email Senders

### **Adding a New Sender**

1. Click "➕ Add Sender"
2. Fill in the details:
   - **Name**: e.g., "Primary Gmail Account"
   - **Email**: your-email@gmail.com
   - **Password**: Your App Password (see below)
   - **Service**: Gmail/Outlook/Custom
   - **Daily Limit**: 500 (Gmail free) or your limit

### **Getting Gmail App Password**

1. Go to https://myaccount.google.com
2. Security → 2-Step Verification (enable it first)
3. App Passwords → Generate
4. Select "Mail" → Your device
5. Copy the 16-character password
6. **Use this in the Password field**

### **Toggle Senders On/Off**

Click the toggle switch next to any sender:
- ✅ **Green** = Active (will be used in round-robin)
- ⚪ **Gray** = Inactive (won't be used)

### **Edit Sender**

Click "✏️ Edit" to update:
- Name
- Password
- Daily limit
- SMTP settings

### **Test Connection**

Click "🧪 Test" to verify the email account works:
```
✅ Connection test successful!
❌ Connection failed: Invalid credentials
```

---

## 📝 Managing Email Templates

### **Creating a Template**

1. Click "➕ Create Template"
2. Fill in:
   - **Name**: e.g., "Cold Outreach - WordPress"
   - **Category**: Outreach, Welcome, Promotion, etc.
   - **Subject**: Use placeholders like `{{name}}`
   - **HTML Content**: Your email HTML
   - **Plain Text**: Fallback for non-HTML clients

### **Placeholders You Can Use**

```
{{name}}      - Recipient's name
{{company}}   - Company name
{{email}}     - Recipient's email
{{site}}      - Website URL
```

### **Example Template**

**Subject:**
```
Partnership Opportunity with {{company}}
```

**HTML Content:**
```html
<h1>Hello {{name}}!</h1>

<p>I came across your website at {{site}} and was impressed by what {{company}} is doing.</p>

<p>I'd love to explore potential partnership opportunities...</p>

<p>Best regards,<br>Your Name</p>
```

### **Preview Your Template**

Click "👁️ Preview" to see how it looks with test data:
- Name: John Doe
- Company: Example Inc
- Email: john@example.com
- Site: example.com

---

## 📨 Creating Campaigns

### **Step-by-Step**

1. **Select Template** - Choose from your active templates
2. **Choose Target**:
   - All Email Contacts
   - WordPress Site Owners Only
   - Company Executives
3. **Set Status**:
   - Queued - Add to queue, start later
   - Sending - Start immediately
4. **Click** "🚀 Create Campaign"

### **What Happens Next**

The system will:

1. ✅ Collect recipients based on your target
2. ✅ Add emails to queue using your template
3. ✅ Send via ACTIVE senders in round-robin
4. ✅ Wait 60 seconds between emails
5. ✅ Wait 10-13 minutes after full cycle
6. ✅ Track sent/failed counts
7. ✅ Retry failed emails up to 3 times

---

## 🎯 How Round-Robin Works

### **Only Active Senders Are Used**

```
You have 5 senders:
✅ Sender #1 (Active)
✅ Sender #2 (Active)
⚪ Sender #3 (Inactive - skipped)
✅ Sender #4 (Active)
✅ Sender #5 (Active)

Round-robin: #1 → #2 → #4 → #5 → #1 → #2 → ...
```

### **Daily Limit Protection**

Each sender tracks:
```
Sender #1: 234/500 emails today ✅
Sender #2: 500/500 emails today ⚠️ FULL
Sender #3: 456/500 emails today ✅

When Sender #2 hits 500:
→ Automatically skipped
→ Other senders continue
```

---

## 📊 Understanding the Dashboard

### **Senders Tab Stats**

- **Total Senders**: All sender accounts
- **Active Senders**: Only enabled accounts
- **Daily Capacity**: Total emails you can send today
- **Sent Today**: Emails sent so far

### **Templates Tab Stats**

- **Total Templates**: All templates
- **Active Templates**: Only enabled templates
- **Categories**: Number of template categories

### **Campaigns Tab Stats**

- **Total Campaigns**: All campaigns created
- **Active Campaigns**: Currently running
- **Emails Queued**: Waiting to be sent
- **Emails Sent**: Successfully delivered

---

## 🔧 Advanced Features

### **Custom SMTP Configuration**

For non-Gmail/Outlook services:

1. Select "Custom SMTP" as service
2. Fill in:
   - SMTP Host: smtp.yourprovider.com
   - SMTP Port: 587 (TLS) or 465 (SSL)
   - Your credentials

### **Template Categories**

Organize templates by purpose:
- **General** - General purpose emails
- **Outreach** - Cold outreach/lead gen
- **Welcome** - Welcome emails
- **Promotion** - Marketing/promotional
- **Follow-up** - Follow-up sequences

### **Placeholders in Templates**

Personalize emails dynamically:
```html
<h1>Hi {{name}}!</h1>
<p>I visited {{site}} and loved what {{company}} is doing.</p>
<p>Contact me at {{email}}</p>
```

---

## 🛡️ Best Practices

### **Email Sender Setup**

✅ **DO:**
- Use App Passwords, not regular passwords
- Set realistic daily limits (500 for Gmail free)
- Test connection before using
- Use multiple senders for better distribution

❌ **DON'T:**
- Use your main Gmail password
- Set daily limits above provider's limits
- Ignore failed connection tests
- Use all senders at maximum capacity

### **Template Design**

✅ **DO:**
- Keep HTML simple and responsive
- Include plain text version
- Test with different email clients
- Use placeholders for personalization
- Include clear call-to-action

❌ **DON'T:**
- Use complex JavaScript or Flash
- Embed large images (use < 100KB)
- Forget plain text version
- Spam-like subject lines
- All caps or excessive exclamation marks

### **Campaign Creation**

✅ **DO:**
- Start with small test campaigns
- Target specific segments
- Monitor delivery rates
- Use personalized templates
- Space out campaigns appropriately

❌ **DON'T:**
- Blast to entire list at once
- Ignore inactive/bad emails
- Send too frequently
- Use generic templates
- Skip testing

---

## 📈 Scaling Your System

### **Phase 1: Start Small**

- 2-3 email senders
- 2-3 basic templates
- Test with 50-100 emails
- Monitor results

### **Phase 2: Scale Up**

- Add more senders (5 recommended)
- Create more templates
- Increase volume gradually
- Optimize based on metrics

### **Phase 3: Advanced**

- Implement drip campaigns
- A/B test templates
- Track opens/clicks
- Segment recipients
- Automate follow-ups

---

## 🐛 Troubleshooting

### **Senders Not Sending**

**Problem**: Emails queued but not sending

**Solutions**:
1. Check if sender is active (toggle on)
2. Test connection
3. Check daily limit not reached
4. Verify credentials
5. Check console for errors

### **Template Not Appearing**

**Problem**: Template not in dropdown

**Solutions**:
1. Check if template is active
2. Reload the page
3. Check browser console for errors

### **High Failure Rate**

**Problem**: Many emails failing

**Solutions**:
1. Verify email addresses are valid
2. Check sender reputation
3. Reduce sending speed
4. Improve email content
5. Check spam score

---

## 📞 API Reference

### **Senders**

```
GET    /api/email/senders          - Get all senders
GET    /api/email/senders/:id      - Get single sender
POST   /api/email/senders          - Create sender
PUT    /api/email/senders/:id      - Update sender
DELETE /api/email/senders/:id      - Delete sender
PATCH  /api/email/senders/:id/toggle - Toggle active/inactive
POST   /api/email/senders/:id/test   - Test connection
```

### **Templates**

```
GET    /api/email/templates        - Get all templates
GET    /api/email/templates/:id    - Get single template
POST   /api/email/templates        - Create template
PUT    /api/email/templates/:id    - Update template
DELETE /api/email/templates/:id    - Delete template
PATCH  /api/email/templates/:id/toggle - Toggle active/inactive
POST   /api/email/templates/:id/preview - Preview with test data
```

### **Campaigns**

```
GET    /api/email/campaigns         - Get all campaigns
POST   /api/email/campaigns         - Create campaign
GET    /api/email/campaigns/:id     - Get campaign details
DELETE /api/email/campaigns/:id     - Delete campaign
```

---

## 🎉 You're All Set!

Now you have a complete email management system where you can:

✅ Manage multiple email sender accounts
✅ Create and manage email templates
✅ Toggle senders/templates on/off
✅ Create targeted email campaigns
✅ Track real-time statistics
✅ Use round-robin distribution
✅ Respect daily limits
✅ Test connections before sending

**Access it at:** `http://localhost:3001/email-manager.html`

**Happy emailing!** 📧🚀
