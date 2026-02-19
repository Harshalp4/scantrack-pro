const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'scanning.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER DEFAULT 1
  );

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
    FOREIGN KEY (location_id) REFERENCES locations(id)
  );

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
  );

  CREATE INDEX IF NOT EXISTS idx_records_date ON daily_records(record_date);
  CREATE INDEX IF NOT EXISTS idx_records_user ON daily_records(user_id);
  CREATE INDEX IF NOT EXISTS idx_users_location ON users(location_id);
  
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  INSERT OR IGNORE INTO settings (key, value) VALUES ('scan_rate', '0.10');
`);

// Create roles table
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description TEXT,
    is_system INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default roles if not exists
const existingRoles = db.prepare('SELECT COUNT(*) as count FROM roles').get();
if (existingRoles.count === 0) {
    const defaultRoles = [
        { role_id: 'super_admin', display_name: 'Super Admin', description: 'Full system access', is_system: 1 },
        { role_id: 'location_manager', display_name: 'Location Admin', description: 'Manage a specific location', is_system: 1 },
        { role_id: 'scanner_operator', display_name: 'Scanner Operator', description: 'Scanning machine operator', is_system: 1 },
        { role_id: 'file_handler', display_name: 'File Handler', description: 'Document file handler', is_system: 1 }
    ];
    const insertRole = db.prepare('INSERT INTO roles (role_id, display_name, description, is_system) VALUES (?, ?, ?, ?)');
    defaultRoles.forEach(r => insertRole.run(r.role_id, r.display_name, r.description, r.is_system));
    console.log('✅ Default roles created');
}

// Schema Migration for Salary Features
try {
    const columns = db.prepare("PRAGMA table_info(users)").all();
    const hasSalaryType = columns.some(c => c.name === 'salary_type');

    if (!hasSalaryType) {
        db.prepare("ALTER TABLE users ADD COLUMN salary_type TEXT DEFAULT 'per_page' CHECK(salary_type IN ('per_page', 'fixed'))").run();
        db.prepare("ALTER TABLE users ADD COLUMN custom_rate REAL").run();
        db.prepare("ALTER TABLE users ADD COLUMN fixed_salary REAL").run();
        console.log('✅ Salary columns added to users table');
    }

    const locColumns = db.prepare("PRAGMA table_info(locations)").all();
    const hasClientRate = locColumns.some(c => c.name === 'client_rate');
    if (!hasClientRate) {
        db.prepare("ALTER TABLE locations ADD COLUMN client_rate REAL DEFAULT 0").run();
        console.log('✅ client_rate column added to locations table');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id INTEGER,
        expense_date DATE NOT NULL,
        amount REAL NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (location_id) REFERENCES locations(id)
      );
      CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
      CREATE INDEX IF NOT EXISTS idx_expenses_location ON expenses(location_id);
    `);

} catch (err) {
    console.error('Migration error:', err.message);
}

// Seed default super admin if not exists
const existingAdmin = db.prepare('SELECT id FROM users WHERE role = ?').get('super_admin');
if (!existingAdmin) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare(`
    INSERT INTO users (username, password, full_name, role)
    VALUES (?, ?, ?, ?)
  `).run('admin', hashedPassword, 'Super Admin', 'super_admin');
    console.log('✅ Default super admin created (username: admin, password: admin123)');
}

module.exports = db;
