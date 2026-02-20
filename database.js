const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

// Turso cloud database config
const TURSO_URL = process.env.TURSO_DATABASE_URL || 'libsql://scantrack-db-harshalpatil5.aws-ap-south-1.turso.io';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzE1MDk4MjUsImlkIjoiNzE4MWY2M2QtNmM2NS00ZWJmLWEzYmQtNzBmMTcwMDRiNzcyIiwicmlkIjoiZGJkYWRiNGQtMTQzZC00NWRkLTgzOGUtYTcwZjk4MjYzNGI3In0.J0uQ-pTN4bfO67GuB2DYjiCHujjeNCPU9Q8A8199g4u1VdoaPZGFNXFVgHkEI5kQmK_XP4ptL7ewgxlajMJqDw';

const client = createClient({
    url: TURSO_URL,
    authToken: TURSO_AUTH_TOKEN
});

// Database wrapper to provide similar API to better-sqlite3
const db = {
    client,

    // Execute raw SQL
    async exec(sql) {
        const statements = sql.split(';').filter(s => s.trim());
        for (const stmt of statements) {
            if (stmt.trim()) {
                await client.execute(stmt);
            }
        }
    },

    // Prepare statement (returns object with run, get, all methods)
    prepare(sql) {
        return {
            sql,
            async run(...params) {
                const result = await client.execute({ sql, args: params });
                return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.rowsAffected };
            },
            async get(...params) {
                const result = await client.execute({ sql, args: params });
                return result.rows[0] || null;
            },
            async all(...params) {
                const result = await client.execute({ sql, args: params });
                return result.rows;
            }
        };
    },

    // Transaction support
    transaction(fn) {
        return async (items) => {
            await client.execute('BEGIN');
            try {
                for (const item of items) {
                    await fn(item);
                }
                await client.execute('COMMIT');
            } catch (err) {
                await client.execute('ROLLBACK');
                throw err;
            }
        };
    }
};

// Initialize database schema
async function initDatabase() {
    console.log('🔄 Connecting to Turso database...');

    // Create tables
    await db.exec(`
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_active INTEGER DEFAULT 1,
            client_rate REAL DEFAULT 0
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            full_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('super_admin', 'location_manager', 'scanner_operator', 'file_handler')),
            location_id INTEGER,
            scanner_id TEXT,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            salary_type TEXT DEFAULT 'per_page' CHECK(salary_type IN ('per_page', 'fixed')),
            custom_rate REAL,
            fixed_salary REAL,
            FOREIGN KEY (location_id) REFERENCES locations(id)
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS daily_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            record_date DATE NOT NULL,
            scan_count INTEGER,
            status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present', 'absent', 'file_close', 'holiday')),
            notes TEXT,
            entered_by INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (entered_by) REFERENCES users(id),
            UNIQUE(user_id, record_date)
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role_id TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            description TEXT,
            is_system INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Expenses table WITHOUT foreign key (allows flexible location management)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS expenses (
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

    // Add document_url column if it doesn't exist (for existing databases)
    try {
        await db.exec(`ALTER TABLE expenses ADD COLUMN document_url TEXT`);
        console.log('✅ Added document_url column to expenses table');
    } catch (e) {
        // Column already exists, ignore error
    }

    // Add paid_by column if it doesn't exist (for existing databases)
    try {
        await db.exec(`ALTER TABLE expenses ADD COLUMN paid_by TEXT`);
        console.log('✅ Added paid_by column to expenses table');
    } catch (e) {
        // Column already exists, ignore error
    }

    // Add paid_from column if it doesn't exist (for existing databases)
    try {
        await db.exec(`ALTER TABLE expenses ADD COLUMN paid_from TEXT`);
        console.log('✅ Added paid_from column to expenses table');
    } catch (e) {
        // Column already exists, ignore error
    }

    // Add daily_target column to users if it doesn't exist
    try {
        await db.exec(`ALTER TABLE users ADD COLUMN daily_target INTEGER`);
        console.log('✅ Added daily_target column to users table');
    } catch (e) {
        // Column already exists, ignore error
    }

    // Create indexes
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_records_date ON daily_records(record_date)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_records_user ON daily_records(user_id)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_users_location ON users(location_id)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date)`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_expenses_location ON expenses(location_id)`);

    // Seed default settings
    const scanRateSetting = await db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get();
    if (!scanRateSetting) {
        await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('scan_rate', '0.10');
    }

    // Seed default roles
    const existingRoles = await db.prepare('SELECT COUNT(*) as count FROM roles').get();
    if (existingRoles.count === 0) {
        const defaultRoles = [
            { role_id: 'super_admin', display_name: 'Super Admin', description: 'Full system access', is_system: 1 },
            { role_id: 'location_manager', display_name: 'Location Admin', description: 'Manage a specific location', is_system: 1 },
            { role_id: 'scanner_operator', display_name: 'Scanner Operator', description: 'Scanning machine operator', is_system: 1 },
            { role_id: 'file_handler', display_name: 'File Handler', description: 'Document file handler', is_system: 1 }
        ];
        for (const r of defaultRoles) {
            await db.prepare('INSERT INTO roles (role_id, display_name, description, is_system) VALUES (?, ?, ?, ?)').run(r.role_id, r.display_name, r.description, r.is_system);
        }
        console.log('✅ Default roles created');
    }

    // Seed default super admin if not exists
    const existingAdmin = await db.prepare('SELECT id FROM users WHERE role = ?').get('super_admin');
    if (!existingAdmin) {
        const hashedPassword = bcrypt.hashSync('admin123', 10);
        await db.prepare(`INSERT INTO users (username, password, full_name, role) VALUES (?, ?, ?, ?)`).run('admin', hashedPassword, 'Super Admin', 'super_admin');
        console.log('✅ Default super admin created (username: admin, password: admin123)');
    }

    // Seed Beed and Admin locations if they don't exist
    const seedLocations = [
        { name: 'Beed', address: 'Beed, Maharashtra' },
        { name: 'Admin', address: 'General/Administrative expenses' }
    ];
    for (const loc of seedLocations) {
        try {
            await db.prepare('INSERT INTO locations (name, address, client_rate, is_active) VALUES (?, ?, 0, 1)').run(loc.name, loc.address);
            console.log(`✅ Created location: ${loc.name}`);
        } catch (e) {
            // Location already exists, ignore
        }
    }

    console.log('✅ Turso database connected and initialized');
}

// Export both db object and init function
module.exports = { db, initDatabase };
