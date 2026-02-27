# WordPress Site Detector

A Playwright-based automation tool that searches Google and identifies which websites are built with WordPress.

## Features

- ✅ Performs Google searches for any query
- 🔍 Detects WordPress sites by checking for:
  - `wp-content` directories
  - `wp-includes` directories
  - `wp-json` REST API endpoints
  - WordPress meta generator tags
  - WordPress-specific CSS classes
  - WordPress script handles
- 📊 Provides detailed summary with statistics
- 🎯 Shows specific indicators found for each WordPress site
- 💾 **Persistent login** - Saves cookies and sessions between runs (no need to accept Google cookies every time!)
- 🗄️ **Database storage** - All results are automatically saved to SQLite database for later analysis
- 📈 **Query & export** - View past searches, statistics, and export data to JSON
- 🖥️ **Admin Panel** - Web interface for managing keywords and viewing results

## Admin Panel (NEW!)

A full-featured web admin panel for managing keywords and viewing results without any command-line operations.

### Start the Admin Panel

```bash
npm run admin
# or
node server.js
```

Then open your browser to: **http://localhost:3000**

### Admin Panel Features

- ✅ **No password required** - Open access admin panel
- 📝 **Keyword CRUD Operations** - Add, edit, delete keywords
- ▶️ **Run Scrapers** - Run scraper for single keyword or all keywords at once
- 📊 **Real-time Statistics** - Dashboard with total searches, sites checked, WordPress/non-WordPress counts
- 🔴 **WordPress Tab** - View all detected WordPress sites with pagination
- ⚪ **Other Sites Tab** - View all non-WordPress sites with pagination
- 🔄 **Auto-refresh** - Automatically updates when scrapers are running
- 💾 **Persistent Storage** - All results saved to database

### Using the Admin Panel

1. **Add Keywords**: Type a keyword and click "Add"
2. **Run Scraper**: Click "▶ Run" next to any keyword, or "▶ Run All" to scrape all keywords
3. **View Results**: Switch between "WordPress Sites" and "Other Sites" tabs
4. **Monitor Progress**: Status badges show pending/running/completed/error states
5. **Browse Results**: Use pagination to navigate through results
6. **Delete Keywords**: Remove keywords you no longer need

## Installation

```bash
npm install
```

## Usage

### Run with default search query ("best coffee shops")

```bash
npm start
```

Or with your own search query:

```bash
node wordpress-detector.js "your search query here"
```

### Examples

```bash
# Search for tech blogs
node wordpress-detector.js "tech blogs"

# Search for local businesses
node wordpress-detector.js "restaurants in new york"

# Search for educational sites
node wordpress-detector.js "programming tutorials"
```

## How It Works

1. Opens a browser and navigates to Google
2. Performs a search with your query
3. Extracts the top 10 search results
4. Visits each URL and analyzes the page
5. Checks for WordPress-specific indicators:
   - References to `/wp-content/`, `/wp-includes/`, `/wp-json/`
   - WordPress meta generator tags
   - WordPress-specific CSS classes and scripts
6. Reports which sites are WordPress and which are not

## Output

The tool provides:

- Real-time progress as it checks each site
- Summary statistics showing WordPress vs non-WordPress ratio
- Detailed list of WordPress sites found with indicators
- List of non-WordPress sites
- **Automatic database storage** - All searches and results are saved to `wordpress-detector.db`

## Viewing Saved Results

All detection results are automatically saved to a SQLite database. Use the `view-results.js` script to query your data:

### List all searches

```bash
npm run list
# or
node view-results.js list
```

### View details of a specific search

```bash
npm run view 1
# or
node view-results.js view 1
```

### Show all WordPress sites found

```bash
npm run wordpress
# or
node view-results.js wordpress
```

### View overall statistics

```bash
npm run stats
# or
node view-results.js stats
```

### Export data to JSON

```bash
npm run export
# or with custom filename
node view-results.js export my-results.json
```

## Configuration

### Persistent Browser Data

The tool uses a persistent browser context (`user-data-dir/`) to save:

- Cookies (so you don't need to accept Google's cookie dialog every run)
- Login sessions (stays logged into accounts across runs)
- Local storage and session data
- Browser preferences

To clear all saved data and start fresh, simply delete the `user-data-dir/` folder:

```bash
rm -rf user-data-dir/
```

### Database Storage

The tool stores all results in a SQLite database (`wordpress-detector.db`):

- **searches table** - Each search run with query, counts, and timestamp
- **sites table** - Individual site checks with WordPress indicators and errors

To clear the database:

```bash
rm wordpress-detector.db
```

You can modify the following in `wordpress-detector.js`:

- `maxResults`: Change the number of search results to check (default: 10)
- Add/remove WordPress detection indicators in the `wordpressIndicators` array
- Adjust timeout values for slower connections

## Requirements

- Node.js
- Playwright (installed via npm)
- Internet connection
