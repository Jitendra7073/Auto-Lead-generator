# WordPress & Lead Generation Automation System

**Human-Friendly Project Guide**

## What is this Project?

This project is an advanced **lead generation and outreach automation tool**. At its core, it automates the process of finding prospective clients (specifically those using WordPress websites), gathering their contact information, finding their key executives on LinkedIn, and eventually reaching out to them via automated email campaigns.

The entire process that a human sales or marketing person would do manually—searching Google, visiting websites one by one, looking for contact pages, copying email addresses and phone numbers, finding the company on LinkedIn, and sending emails—is automated by this software.

---

## The Main Motives / Goals of the Project

1. **Find Potential Leads**: Search Google using specific keywords (e.g., "best coffee shops in New York") and identify which of the search results are websites built with **WordPress**.
2. **Extract Contact Information**: Automatically visit these websites, find their "Contact Us" pages, and scrape valuable data:
   - Email addresses
   - Phone numbers
   - LinkedIn Company profiles
3. **Identify Key Decision Makers**: Take the scraped LinkedIn company profiles and find the executives (like CEOs, Founders, Marketing Directors) who work there.
4. **Automate Outreach**: Provide an entire email queue system with templates to send automated emails to the contacts we just found.
5. **Manage Everything visually**: Provide a web-based Admin Panel (Dashboard) where you can see all the statistics, manage keywords, view leads, and run scrapers without touching any code.

---

## How it Works (Step-by-Step Flow)

### Step 1: Searching & WordPress Detection

- The system opens a real, visible Chrome browser (using a technology called Playwright) and goes to Google.
- It searches for the keywords you provide.
- For every website Google returns, it visits the site and analyzes the code to see if it's built with WordPress (checking for things like `wp-content` folders, specific WordPress code signatures, etc.).

### Step 2: Deep Scraping & Data Extraction

- While checking if the site is WordPress, it also hunts for contact forms or "About" pages.
- It scans the text and automatically extracts any properly formatted email addresses, phone numbers, and links to LinkedIn.
- All this data is safely stored in a local SQLite database (`wordpress-detector.db`).

### Step 3: Executive Scraper (LinkedIn)

- There is a separate background process (`linkedin-company-scraper.js`) that takes the LinkedIn company URLs extracted in Step 2.
- It visits those LinkedIn company pages and looks at the "People" or "Employees" section.
- It scrapes the names and roles of the executives so you know exactly _who_ to email, not just _what_ company to email.

### Step 4: Email Automation

- A built-in email queue worker (`email-queue-worker.js`) runs in the background.
- It allows you to create HTML email templates and schedule campaigns.
- It processes the queue securely and sends out emails to the collected leads, allowing you to directly market your services (e.g., WordPress maintenance, SEO, web design) to the right people.

---

## How to Interact with the Project

You don't need to be a programmer to use the system on a daily basis. The project provides a friendly **Admin Panel**.

### Starting the Dashboard

To start the visual dashboard, you simply run this command in your terminal/command prompt while inside the project folder:

```bash
npm run admin
```

Then, open your web browser and go to: **http://localhost:3000**

### What you can do in the Dashboard:

- **Manage Keywords**: Add search terms (like "plumbers in Texas" or "tech startups").
- **Run Scrapers**: Click a "Run" button next to a keyword. A browser will magically open and start searching and scraping for you.
- **View Results**: Switch between tabs to see all the WordPress sites found, the emails captured, and the executives identified.

### Data Storage

- Everything is permanently saved in a local file called `wordpress-detector.db`. Even if you close the program or turn off your computer, your leads are safe.
- It also saves browser "cookies" so that you stay logged into Google and LinkedIn, preventing you from having to solve CAPTCHAs or log in every single time.

---

## File Structure (For Your Reference)

Here is what the important files in the project do:

- **`server.js`**: The heart of the web Admin Panel. It provides all the data (API routes) to the visual dashboard (http://localhost:3000).
- **`wordpress-detector.js`**: The core script that opens Google, searches keywords, and checks if sites use WordPress.
- **`linkedin-company-scraper.js`**: Takes the LinkedIn URLs found and scrapes the company's employee data.
- **`email-queue-worker.js` / `email-senders-templates-api.js`**: Handles the entire automated email marketing side of the project.
- **`database.js`**: Talks to the SQLite database to save and retrieve all your leads, statistics, and keywords.
- **`public/` folder**: Contains the HTML/CSS/JS for the actual visual dashboard you interact with on port 3000.

---

## Summary

Think of this project as a **virtual sales assistant**. You tell it what kind of businesses you are looking for (Keywords), and it will automatically find them, check if they use WordPress, grab their emails/phones, find out who their boss is on LinkedIn, and get them ready for you to send an automated marketing email!
