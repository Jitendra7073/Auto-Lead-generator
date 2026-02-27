const db = require('./database');

/**
 * Display all searches
 */
function showAllSearches() {
  const searches = db.getAllSearches();

  if (searches.length === 0) {
    console.log('\n📭 No searches found in database.\n');
    return;
  }

  console.log('\n' + '═'.repeat(100));
  console.log('📋 ALL SEARCHES');
  console.log('═'.repeat(100));

  searches.forEach(search => {
    const percentage = ((search.wordpress_count / search.total_sites) * 100).toFixed(1);
    console.log(`\nID: ${search.id}`);
    console.log(`Query: "${search.query}"`);
    console.log(`Date: ${new Date(search.created_at).toLocaleString()}`);
    console.log(`Results: ${search.total_sites} sites | WordPress: ${search.wordpress_count} (${percentage}%) | Non-WordPress: ${search.non_wordpress_count}`);
    console.log('─'.repeat(100));
  });

  console.log('\n' + '═'.repeat(100));
}

/**
 * Show details for a specific search
 * @param {number} searchId - Search ID
 */
function showSearchDetails(searchId) {
  const search = db.getSearchById(searchId);

  if (!search) {
    console.log(`\n❌ Search with ID ${searchId} not found.\n`);
    return;
  }

  const percentage = ((search.wordpress_count / search.total_sites) * 100).toFixed(1);

  console.log('\n' + '═'.repeat(100));
  console.log(`📋 SEARCH DETAILS - ID: ${search.id}`);
  console.log('═'.repeat(100));
  console.log(`\nQuery: "${search.query}"`);
  console.log(`Date: ${new Date(search.created_at).toLocaleString()}`);
  console.log(`\n📊 Statistics:`);
  console.log(`  Total sites: ${search.total_sites}`);
  console.log(`  WordPress: ${search.wordpress_count} (${percentage}%)`);
  console.log(`  Non-WordPress: ${search.non_wordpress_count}`);

  console.log('\n\n🔴 WordPress Sites:');
  search.sites.filter(s => s.is_wordpress).forEach(site => {
    console.log(`\n  • ${site.url}`);
    console.log(`    Indicators: ${site.indicators}`);
    console.log(`    Checked: ${new Date(site.checked_at).toLocaleString()}`);
  });

  console.log('\n\n⚪ Non-WordPress Sites:');
  search.sites.filter(s => !s.is_wordpress).forEach(site => {
    console.log(`\n  • ${site.url}`);
    if (site.error) {
      console.log(`    Error: ${site.error}`);
    }
  });

  console.log('\n' + '═'.repeat(100));
}

/**
 * Show all WordPress sites across all searches
 */
function showAllWordpressSites() {
  const sites = db.getAllWordpressSites();

  if (sites.length === 0) {
    console.log('\n📭 No WordPress sites found in database.\n');
    return;
  }

  console.log('\n' + '═'.repeat(100));
  console.log(`🔴 ALL WORDPRESS SITES (${sites.length} total)`);
  console.log('═'.repeat(100));

  // Group by URL to avoid duplicates
  const uniqueSites = new Map();

  sites.forEach(site => {
    if (!uniqueSites.has(site.url)) {
      uniqueSites.set(site.url, site);
    }
  });

  uniqueSites.forEach(site => {
    console.log(`\n• ${site.url}`);
    console.log(`  Indicators: ${site.indicators}`);
    console.log(`  Found in search: "${site.search_query}"`);
    console.log(`  Last checked: ${new Date(site.checked_at).toLocaleString()}`);
  });

  console.log('\n' + '═'.repeat(100));
}

/**
 * Show statistics
 */
function showStatistics() {
  const stats = db.getStatistics();

  console.log('\n' + '═'.repeat(100));
  console.log('📊 OVERALL STATISTICS');
  console.log('═'.repeat(100));

  const wpPercentage = stats.total_sites_checked > 0
    ? ((stats.total_wordpress_sites / stats.total_sites_checked) * 100).toFixed(1)
    : 0;

  console.log(`\nTotal searches performed: ${stats.total_searches || 0}`);
  console.log(`Total sites checked: ${stats.total_sites_checked || 0}`);
  console.log(`WordPress sites found: ${stats.total_wordpress_sites || 0} (${wpPercentage}%)`);
  console.log(`Non-WordPress sites: ${stats.total_non_wordpress_sites || 0}`);

  if (stats.topQueries && stats.topQueries.length > 0) {
    console.log('\n\n🔝 Most searched queries:');
    stats.topQueries.forEach((q, i) => {
      console.log(`\n  ${i + 1}. "${q.query}"`);
      console.log(`     Searched ${q.search_count} time(s), found ${q.wordpress_found} WordPress sites`);
    });
  }

  console.log('\n' + '═'.repeat(100));
}

/**
 * Show all LinkedIn profiles found
 */
function showLinkedinProfiles() {
  const profiles = db.getLinkedinProfiles(1, 100); // Get first 100 profiles

  if (profiles.linkedin_profiles.length === 0) {
    console.log('\n📭 No LinkedIn profiles found in database.\n');
    return;
  }

  console.log('\n' + '═'.repeat(100));
  console.log(`💼 ALL LINKEDIN PROFILES (${profiles.total} total)`);
  console.log('═'.repeat(100));

  profiles.linkedin_profiles.forEach(profile => {
    console.log(`\n• ${profile.linkedin_url}`);
    console.log(`  Source: ${profile.site_url}`);
    console.log(`  WordPress Site: ${profile.is_wordpress ? 'Yes' : 'No'}`);
    console.log(`  Found in search: "${profile.search_query}"`);
    console.log(`  Extracted: ${new Date(profile.created_at).toLocaleString()}`);
  });

  console.log('\n' + '═'.repeat(100));
}

/**
 * Show all contacts by type
 * @param {string} type - Contact type (email, phone, linkedin, or all)
 */
function showContacts(type = 'all') {
  const contacts = db.getAllContacts(type, 1, 100); // Get first 100 contacts

  if (contacts.contacts.length === 0) {
    console.log(`\n📭 No ${type === 'all' ? 'contacts' : type} found in database.\n`);
    return;
  }

  console.log('\n' + '═'.repeat(100));
  console.log(`📞 ALL ${type.toUpperCase()} CONTACTS (${contacts.total} total)`);
  console.log('═'.repeat(100));

  contacts.contacts.forEach(contact => {
    console.log(`\n• ${contact.value}`);
    console.log(`  Type: ${contact.type}`);
    console.log(`  Source: ${contact.site_url}`);
    console.log(`  WordPress Site: ${contact.is_wordpress ? 'Yes' : 'No'}`);
    console.log(`  Found in search: "${contact.search_query}"`);
    console.log(`  Extracted: ${new Date(contact.created_at).toLocaleString()}`);
  });

  console.log('\n' + '═'.repeat(100));
}

/**
 * Export data to JSON
 * @param {string} filename - Output filename
 */
function exportData(filename = 'wordpress-detector-export.json') {
  db.exportToJSON(filename);
}

// Main CLI handler
function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  switch (command) {
    case 'list':
    case 'ls':
      showAllSearches();
      break;

    case 'view':
    case 'show':
      if (!arg) {
        console.log('\n❌ Please provide a search ID.');
        console.log('Usage: node view-results.js view <search-id>\n');
        return;
      }
      showSearchDetails(parseInt(arg));
      break;

    case 'wordpress':
    case 'wp':
      showAllWordpressSites();
      break;

    case 'stats':
    case 'statistics':
      showStatistics();
      break;

    case 'export':
      const filename = arg || 'wordpress-detector-export.json';
      exportData(filename);
      break;

    case 'linkedin':
    case 'linkedin-profiles':
      showLinkedinProfiles();
      break;

    case 'contacts':
      const contactType = arg || 'all';
      showContacts(contactType);
      break;

    default:
      console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                  WordPress Detector - Database Query Tool                    ║
╚══════════════════════════════════════════════════════════════════════════════╝

Usage: node view-results.js <command> [arguments]

Commands:
  list, ls              List all searches in the database
  view, show <id>       Show details for a specific search ID
  wordpress, wp         Show all WordPress sites found across all searches
  stats, statistics     Show overall statistics
  export [filename]     Export all data to JSON file (default: wordpress-detector-export.json)
  linkedin              Show all LinkedIn profiles found
  contacts [type]       Show all contacts (email, phone, linkedin, or all)

Examples:
  node view-results.js list
  node view-results.js view 1
  node view-results.js wordpress
  node view-results.js stats
  node view-results.js export my-results.json
  node view-results.js linkedin
  node view-results.js contacts email
  node view-results.js contacts linkedin
      `);
  }
}

main();
