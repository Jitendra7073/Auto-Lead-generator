/**
 * CLI to run the LinkedIn Company Executives Scraper
 */

const { LinkedInCompanyScraper, scrapeCompanyUrls } = require('./linkedin-company-scraper');
const { getExecutivesStats, getCompanyExecutives } = require('./database');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'scrape':
      console.log('🚀 Starting LinkedIn Company Executives Scraper...\n');
      await scrapeCompanyUrls();
      break;

    case 'stats':
      const stats = getExecutivesStats();
      console.log('\n📊 Company Executives Statistics:');
      console.log('================================');
      console.log(`Total Executives: ${stats.total_executives}`);
      console.log(`Total Companies: ${stats.total_companies}`);
      console.log(`Total Sites: ${stats.total_sites}`);
      console.log('\nBy Role:');
      console.log(`  Founders: ${stats.founders}`);
      console.log(`  Co-Founders: ${stats.co_founders}`);
      console.log(`  CEOs: ${stats.ceos}`);
      console.log(`  Presidents: ${stats.presidents}`);
      console.log(`  Owners: ${stats.owners}`);
      break;

    case 'list':
      const page = parseInt(args[1]) || 1;
      const limit = parseInt(args[2]) || 20;
      const role = args[3] || 'all';

      const result = getCompanyExecutives(page, limit, null, role);
      console.log(`\n👥 Company Executives (Page ${page}/${result.pagination.totalPages}):`);
      console.log('='.repeat(100));

      result.executives.forEach(exec => {
        console.log(`\n📌 ${exec.name || 'Unknown'}`);
        console.log(`   Role: ${exec.role_category || 'Unknown'}`);
        console.log(`   Headline: ${exec.headline || 'N/A'}`);
        console.log(`   Company: ${exec.company_name || 'Unknown'}`);
        console.log(`   Company URL: ${exec.company_url}`);
        console.log(`   Profile: ${exec.profile_url}`);
      });

      console.log(`\n📊 Showing ${result.executives.length} of ${result.pagination.total} total executives`);
      break;

    default:
      console.log(`
LinkedIn Company Executives Scraper
==================================

Usage:
  node run-executives-scraper.js <command>

Commands:
  scrape        Scrape executives from all LinkedIn company URLs in database
  stats         Show statistics about scraped executives
  list [page] [limit] [role]    List executives (optional: page, limit, role filter)

Examples:
  node run-executives-scraper.js scrape
  node run-executives-scraper.js stats
  node run-executives-scraper.js list 1 20
  node run-executives-scraper.js list 1 20 founder
  node run-executives-scraper.js list 1 20 ceo
      `);
  }
}

main().catch(console.error);
