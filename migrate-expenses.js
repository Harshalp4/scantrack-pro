const { createClient } = require('@libsql/client');
const xlsx = require('xlsx');

// Turso cloud database config
const TURSO_URL = process.env.TURSO_DATABASE_URL || 'libsql://scantrack-db-harshalpatil5.aws-ap-south-1.turso.io';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzE1MDk4MjUsImlkIjoiNzE4MWY2M2QtNmM2NS00ZWJmLWEzYmQtNzBmMTcwMDRiNzcyIiwicmlkIjoiZGJkYWRiNGQtMTQzZC00NWRkLTgzOGUtYTcwZjk4MjYzNGI3In0.J0uQ-pTN4bfO67GuB2DYjiCHujjeNCPU9Q8A8199g4u1VdoaPZGFNXFVgHkEI5kQmK_XP4ptL7ewgxlajMJqDw';

const client = createClient({
    url: TURSO_URL,
    authToken: TURSO_AUTH_TOKEN
});

// Convert Excel serial date to YYYY-MM-DD
function excelDateToISO(serial) {
    if (typeof serial === 'string') {
        // Format: "21-01-2026" -> "2026-01-21"
        const parts = serial.split('-');
        if (parts.length === 3) {
            return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
        return serial;
    }
    // Excel serial date
    const utc_days = Math.floor(serial - 25569);
    const date = new Date(utc_days * 86400 * 1000);
    return date.toISOString().split('T')[0];
}

async function migrate() {
    console.log('Starting expense migration...\n');

    // Step 1: Get existing locations
    console.log('1. Fetching existing locations...');
    const locations = await client.execute('SELECT id, name FROM locations');
    const locationMap = {};
    locations.rows.forEach(l => {
        locationMap[l.name.toLowerCase()] = l.id;
    });
    console.log('   Locations:', Object.keys(locationMap).join(', '));

    // Step 2: Add Beed location if not exists
    if (!locationMap['beed']) {
        console.log('\n2. Adding Beed location...');
        await client.execute({
            sql: 'INSERT INTO locations (name, address, client_rate, is_active) VALUES (?, ?, ?, ?)',
            args: ['Beed', 'Beed, Maharashtra', 0, 1]
        });
        const newLoc = await client.execute("SELECT id FROM locations WHERE name = 'Beed'");
        locationMap['beed'] = newLoc.rows[0].id;
        console.log('   Added Beed with ID:', locationMap['beed']);
    }

    // Step 3: Add Admin location if not exists
    if (!locationMap['admin']) {
        console.log('\n3. Adding Admin location...');
        await client.execute({
            sql: 'INSERT INTO locations (name, address, client_rate, is_active) VALUES (?, ?, ?, ?)',
            args: ['Admin', 'General/Administrative expenses', 0, 1]
        });
        const newLoc = await client.execute("SELECT id FROM locations WHERE name = 'Admin'");
        locationMap['admin'] = newLoc.rows[0].id;
        console.log('   Added Admin with ID:', locationMap['admin']);
    }

    // Step 4: Recreate expenses table without FK
    console.log('\n4. Recreating expenses table without FK...');

    // Drop old table
    await client.execute('DROP TABLE IF EXISTS expenses');

    // Create new table without FK
    await client.execute(`
        CREATE TABLE expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_id INTEGER,
            expense_date DATE NOT NULL,
            amount REAL NOT NULL,
            description TEXT,
            document_url TEXT,
            paid_by TEXT,
            paid_from TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Create indexes
    await client.execute('CREATE INDEX idx_expenses_date ON expenses(expense_date)');
    await client.execute('CREATE INDEX idx_expenses_location ON expenses(location_id)');
    console.log('   Table recreated successfully');

    // Step 5: Read Excel and import data
    console.log('\n5. Reading Excel file...');
    const workbook = xlsx.readFile('/Users/harshal/Downloads/HNV Expences.xlsx');
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    // Skip header rows (first 2 rows based on previous analysis)
    console.log('   Found', data.length, 'rows (including headers)');

    let imported = 0;
    let skipped = 0;

    // Start from row 3 (index 2) since first 2 rows are headers
    for (let i = 2; i < data.length; i++) {
        const row = data[i];

        // Skip empty rows
        if (!row || row.length < 2 || !row[0] || !row[1]) {
            skipped++;
            continue;
        }

        // Parse fields: Date, amount, location, reason, given to whome, from which account
        const dateVal = row[0];
        const amount = parseFloat(row[1]) || 0;
        const locationName = row[2] ? String(row[2]).toLowerCase().trim() : null;
        const description = row[3] || '';
        const paidBy = row[4] || null;
        const paidFrom = row[5] || null;

        if (amount <= 0) {
            skipped++;
            continue;
        }

        // Convert date
        let expenseDate;
        try {
            expenseDate = excelDateToISO(dateVal);
        } catch (e) {
            console.log('   Skipping row', i + 1, '- invalid date:', dateVal);
            skipped++;
            continue;
        }

        // Get location_id (null if not found - user can edit later)
        let locationId = null;
        if (locationName) {
            locationId = locationMap[locationName] || null;
        }

        // Insert expense
        try {
            await client.execute({
                sql: 'INSERT INTO expenses (location_id, expense_date, amount, description, paid_by, paid_from) VALUES (?, ?, ?, ?, ?, ?)',
                args: [locationId, expenseDate, amount, description, paidBy, paidFrom]
            });
            imported++;
            console.log(`   ✅ Row ${i + 1}: ${expenseDate} | ₹${amount.toLocaleString('en-IN')} | ${locationName || 'No location'} | ${description.substring(0, 30)}`);
        } catch (e) {
            console.log(`   ❌ Row ${i + 1} error:`, e.message);
            skipped++;
        }
    }

    console.log('\n========================================');
    console.log('Migration complete!');
    console.log(`Imported: ${imported} expenses`);
    console.log(`Skipped: ${skipped} rows`);

    // Show totals by location
    const totals = await client.execute(`
        SELECT l.name, COALESCE(SUM(e.amount), 0) as total
        FROM expenses e
        LEFT JOIN locations l ON e.location_id = l.id
        GROUP BY e.location_id
        ORDER BY total DESC
    `);
    console.log('\nTotals by location:');
    totals.rows.forEach(r => {
        console.log(`  ${r.name || 'No Location'}: ₹${parseFloat(r.total).toLocaleString('en-IN')}`);
    });
}

migrate().catch(console.error);
