const db = require('./database');

console.log('🔍 Checking database structure...\n');

try {
  const database = db.initDatabase();

  // Get all table names
  const tables = database.prepare(`
    SELECT name FROM sqlite_master WHERE type='table'
  `).all();

  console.log('✅ Tables found:');
  tables.forEach(table => {
    console.log(`   - ${table.name}`);
  });

  console.log('\n📊 Table structures:\n');

  // Check searches table
  console.log('📁 searches table:');
  const searchesColumns = database.prepare(`PRAGMA table_info(searches)`).all();
  searchesColumns.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });

  // Check sites table
  console.log('\n📁 sites table:');
  const sitesColumns = database.prepare(`PRAGMA table_info(sites)`).all();
  sitesColumns.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });

  // Check contacts table
  console.log('\n📁 contacts table:');
  const contactsColumns = database.prepare(`PRAGMA table_info(contacts)`).all();
  contactsColumns.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });

  // Check keywords table
  console.log('\n📁 keywords table:');
  const keywordsColumns = database.prepare(`PRAGMA table_info(keywords)`).all();
  keywordsColumns.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });

  console.log('\n📈 Current data counts:');

  const searches = database.prepare(`SELECT COUNT(*) as count FROM searches`).get();
  console.log(`   - Searches: ${searches.count}`);

  const sites = database.prepare(`SELECT COUNT(*) as count FROM sites`).get();
  console.log(`   - Sites: ${sites.count}`);

  const wpSites = database.prepare(`SELECT COUNT(*) as count FROM sites WHERE is_wordpress = 1`).get();
  console.log(`   - WordPress sites: ${wpSites.count}`);

  const contacts = database.prepare(`SELECT COUNT(*) as count FROM contacts`).get();
  console.log(`   - Total contacts: ${contacts.count}`);

  const emails = database.prepare(`SELECT COUNT(*) as count FROM contacts WHERE type = 'email'`).get();
  console.log(`   - Emails: ${emails.count}`);

  const phones = database.prepare(`SELECT COUNT(*) as count FROM contacts WHERE type = 'phone'`).get();
  console.log(`   - Phones: ${phones.count}`);

  const linkedins = database.prepare(`SELECT COUNT(*) as count FROM contacts WHERE type = 'linkedin'`).get();
  console.log(`   - LinkedIn profiles: ${linkedins.count}`);

  const keywords = database.prepare(`SELECT COUNT(*) as count FROM keywords`).get();
  console.log(`   - Keywords: ${keywords.count}`);

  // Show sample LinkedIn URLs if any exist
  if (linkedins.count > 0) {
    console.log('\n🔗 Sample LinkedIn profiles found:');
    const sampleLinkedins = database.prepare(`
      SELECT c.value, s.url as site_url
      FROM contacts c
      INNER JOIN sites s ON c.site_id = s.id
      WHERE c.type = 'linkedin'
      LIMIT 5
    `).all();

    sampleLinkedins.forEach((li, i) => {
      console.log(`   ${i + 1}. ${li.value}`);
      console.log(`      from: ${li.site_url}`);
    });
  }

  database.close();

  console.log('\n✅ Database check complete!\n');
} catch (error) {
  console.error('❌ Error checking database:', error.message);
}
