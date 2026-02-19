const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const db = require('./database');
const { createBackup } = require('./backup');

const app = express();
const PORT = process.env.PORT || 3500;
const JWT_SECRET = process.env.JWT_SECRET || 'scanning-tracker-secret-key-2026';

// Auto backup on server start
console.log('📦 Creating startup backup...');
createBackup();

// Schedule daily backup at midnight
function scheduleDailyBackup() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0); // Next midnight
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
        console.log('⏰ Running scheduled daily backup...');
        createBackup();
        // Schedule next backup (every 24 hours)
        setInterval(() => {
            console.log('⏰ Running scheduled daily backup...');
            createBackup();
        }, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);

    console.log(`⏰ Next backup scheduled at midnight (in ${Math.round(msUntilMidnight / 1000 / 60)} minutes)`);
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth Middleware
function authenticate(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

function authorize(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

// =================== AUTH ROUTES ===================

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT u.*, l.name as location_name FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE u.username = ? AND u.is_active = 1').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, full_name: user.full_name, location_id: user.location_id, location_name: user.location_name, scanner_id: user.scanner_id },
        JWT_SECRET,
        { expiresIn: '24h' }
    );
    res.json({
        token,
        user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, location_id: user.location_id, location_name: user.location_name, scanner_id: user.scanner_id }
    });
});

app.get('/api/auth/me', authenticate, (req, res) => {
    const user = db.prepare('SELECT u.id, u.username, u.full_name, u.role, u.location_id, u.scanner_id, l.name as location_name FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE u.id = ?').get(req.user.id);
    res.json(user);
});

app.post('/api/auth/change-password', authenticate, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(currentPassword, user.password)) {
        return res.status(400).json({ error: 'Current password is incorrect' });
    }
    const hashed = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.user.id);
    res.json({ message: 'Password changed successfully' });
});

// =================== LOCATION ROUTES ===================

app.get('/api/locations', authenticate, (req, res) => {
    let locations;
    if (req.user.role === 'super_admin') {
        locations = db.prepare('SELECT * FROM locations ORDER BY name').all();
    } else {
        locations = db.prepare('SELECT * FROM locations WHERE id = ? AND is_active = 1').all(req.user.location_id);
    }
    // Add employee count for each location
    locations = locations.map(loc => {
        const count = db.prepare('SELECT COUNT(*) as count FROM users WHERE location_id = ? AND role != ? AND is_active = 1').get(loc.id, 'super_admin');
        return { ...loc, employee_count: count.count };
    });
    res.json(locations);
});

app.post('/api/locations', authenticate, authorize('super_admin'), (req, res) => {
    const { name, address, client_rate } = req.body;
    if (!name) return res.status(400).json({ error: 'Location name is required' });
    try {
        const result = db.prepare('INSERT INTO locations (name, address, client_rate) VALUES (?, ?, ?)')
            .run(name, address || '', client_rate || 0);
        res.json({ id: result.lastInsertRowid, name, address, client_rate, message: 'Location created successfully' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Location name already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/locations/:id', authenticate, authorize('super_admin'), (req, res) => {
    const { name, address, is_active, client_rate } = req.body;
    db.prepare('UPDATE locations SET name = COALESCE(?, name), address = COALESCE(?, address), is_active = COALESCE(?, is_active), client_rate = COALESCE(?, client_rate) WHERE id = ?')
        .run(name, address, is_active, client_rate, req.params.id);
    res.json({ message: 'Location updated successfully' });
});

app.delete('/api/locations/:id', authenticate, authorize('super_admin'), (req, res) => {
    db.prepare('UPDATE locations SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json({ message: 'Location deactivated' });
});

// =================== EXPENSES ROUTES ===================

app.get('/api/expenses', authenticate, authorize('super_admin'), (req, res) => {
    const { location_id, month } = req.query;
    let query = `SELECT e.*, l.name as location_name FROM expenses e JOIN locations l ON e.location_id = l.id WHERE 1=1`;
    const params = [];

    if (location_id) {
        query += ' AND e.location_id = ?';
        params.push(location_id);
    }
    if (month) {
        query += " AND strftime('%Y-%m', e.expense_date) = ?";
        params.push(month);
    }
    query += ' ORDER BY e.expense_date DESC';
    const expenses = db.prepare(query).all(...params);
    res.json(expenses);
});

app.post('/api/expenses', authenticate, authorize('super_admin'), (req, res) => {
    const { location_id, expense_date, amount, description } = req.body;
    if (!location_id || !expense_date || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const result = db.prepare('INSERT INTO expenses (location_id, expense_date, amount, description) VALUES (?, ?, ?, ?)')
        .run(location_id, expense_date, amount, description || '');
    res.json({ id: result.lastInsertRowid, message: 'Expense added' });
});

app.delete('/api/expenses/:id', authenticate, authorize('super_admin'), (req, res) => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.json({ message: 'Expense deleted' });
});

// =================== USER/EMPLOYEE ROUTES ===================

app.get('/api/users', authenticate, (req, res) => {
    const { location_id, role } = req.query;
    let query = `SELECT u.id, u.username, u.full_name, u.role, u.location_id, u.scanner_id, u.is_active, u.created_at, l.name as location_name,
               u.salary_type, u.custom_rate, u.fixed_salary
               FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE 1=1`;
    const params = [];

    if (req.user.role !== 'super_admin') {
        query += ' AND u.location_id = ?';
        params.push(req.user.location_id);
    } else if (location_id) {
        query += ' AND u.location_id = ?';
        params.push(location_id);
    }

    if (role) {
        query += ' AND u.role = ?';
        params.push(role);
    }

    query += ' AND u.role != ? AND u.is_active = 1 ORDER BY u.full_name';
    params.push('super_admin');

    const users = db.prepare(query).all(...params);
    res.json(users);
});

app.post('/api/users', authenticate, authorize('super_admin', 'location_manager'), (req, res) => {
    const { username, password, full_name, role, location_id, scanner_id } = req.body;
    if (!username || !password || !full_name || !role) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    // Location managers can only create users for their own location
    const targetLocationId = req.user.role === 'super_admin' ? location_id : req.user.location_id;

    if (role === 'super_admin' && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Cannot create super admin' });
    }

    try {
        const hashed = bcrypt.hashSync(password, 10);
        const result = db.prepare('INSERT INTO users (username, password, full_name, role, location_id, scanner_id, salary_type, custom_rate, fixed_salary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(username, hashed, full_name, role, targetLocationId, scanner_id || null, req.body.salary_type || 'per_page', req.body.custom_rate || null, req.body.fixed_salary || null);
        res.json({ id: result.lastInsertRowid, message: 'User created successfully' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:id', authenticate, authorize('super_admin', 'location_manager'), (req, res) => {
    const { full_name, role, scanner_id, is_active, password } = req.body;

    // Location managers can only edit users in their own location
    if (req.user.role === 'location_manager') {
        const targetUser = db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.params.id);
        if (!targetUser || targetUser.location_id !== req.user.location_id) {
            return res.status(403).json({ error: 'You can only edit employees at your location' });
        }
        // Location managers cannot promote users to location_manager
        if (role === 'location_manager' || role === 'super_admin') {
            return res.status(403).json({ error: 'You cannot assign this role' });
        }
    }

    if (password) {
        const hashed = bcrypt.hashSync(password, 10);
        db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.params.id);
    }

    db.prepare(`UPDATE users SET
    full_name = COALESCE(?, full_name),
    role = COALESCE(?, role),
    scanner_id = COALESCE(?, scanner_id),
    is_active = COALESCE(?, is_active),
    salary_type = COALESCE(?, salary_type),
    custom_rate = COALESCE(?, custom_rate),
    fixed_salary = COALESCE(?, fixed_salary)
    WHERE id = ?`)
        .run(full_name, role, scanner_id, is_active, req.body.salary_type, req.body.custom_rate, req.body.fixed_salary, req.params.id);
    res.json({ message: 'User updated successfully' });
});

app.delete('/api/users/:id', authenticate, authorize('super_admin', 'location_manager'), (req, res) => {
    // Location managers can only delete users in their own location
    if (req.user.role === 'location_manager') {
        const targetUser = db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.params.id);
        if (!targetUser || targetUser.location_id !== req.user.location_id) {
            return res.status(403).json({ error: 'You can only deactivate employees at your location' });
        }
    }
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(req.params.id);
    res.json({ message: 'User deactivated' });
});

// =================== DAILY RECORDS ROUTES ===================

app.get('/api/records', authenticate, (req, res) => {
    const { location_id, user_id, start_date, end_date, month, year } = req.query;

    let query = `SELECT dr.*, u.full_name, u.scanner_id, u.role as user_role, l.name as location_name 
               FROM daily_records dr 
               JOIN users u ON dr.user_id = u.id 
               LEFT JOIN locations l ON u.location_id = l.id 
               WHERE 1=1`;
    const params = [];

    // Restrict based on role
    if (req.user.role === 'scanner_operator' || req.user.role === 'file_handler') {
        query += ' AND dr.user_id = ?';
        params.push(req.user.id);
    } else if (req.user.role === 'location_manager') {
        query += ' AND u.location_id = ?';
        params.push(req.user.location_id);
    } else if (location_id) {
        query += ' AND u.location_id = ?';
        params.push(location_id);
    }

    if (user_id) {
        query += ' AND dr.user_id = ?';
        params.push(user_id);
    }

    if (start_date && end_date) {
        query += ' AND dr.record_date BETWEEN ? AND ?';
        params.push(start_date, end_date);
    } else if (month && year) {
        const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
        const endOfMonth = new Date(year, month, 0).toISOString().split('T')[0];
        query += ' AND dr.record_date BETWEEN ? AND ?';
        params.push(startOfMonth, endOfMonth);
    }

    query += ' ORDER BY dr.record_date DESC, u.full_name';
    const records = db.prepare(query).all(...params);
    res.json(records);
});

// Get monthly tracking view (like the Excel sheet)
app.get('/api/records/monthly', authenticate, (req, res) => {
    const { location_id, month, year } = req.query;
    const m = parseInt(month) || new Date().getMonth() + 1;
    const y = parseInt(year) || new Date().getFullYear();
    const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
    const daysInMonth = new Date(y, m, 0).getDate();
    const endDate = `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

    let usersQuery = 'SELECT u.id, u.full_name, u.role, u.scanner_id, u.location_id, u.salary_type, u.custom_rate, u.fixed_salary, l.name as location_name FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE u.is_active = 1 AND u.role != ?';
    const usersParams = ['super_admin'];

    if (req.user.role === 'location_manager') {
        usersQuery += ' AND u.location_id = ?';
        usersParams.push(req.user.location_id);
    } else if (req.user.role === 'scanner_operator' || req.user.role === 'file_handler') {
        usersQuery += ' AND u.id = ?';
        usersParams.push(req.user.id);
    } else if (location_id) {
        usersQuery += ' AND u.location_id = ?';
        usersParams.push(location_id);
    }

    usersQuery += ' ORDER BY u.role, u.full_name';
    const users = db.prepare(usersQuery).all(...usersParams);

    const records = db.prepare(`
    SELECT dr.user_id, dr.record_date, dr.scan_count, dr.status, dr.notes
    FROM daily_records dr
    JOIN users u ON dr.user_id = u.id
    WHERE dr.record_date BETWEEN ? AND ?
    ${req.user.role === 'location_manager' ? 'AND u.location_id = ?' : ''}
    ${(req.user.role === 'scanner_operator' || req.user.role === 'file_handler') ? 'AND dr.user_id = ?' : ''}
    ${(req.user.role === 'super_admin' && location_id) ? 'AND u.location_id = ?' : ''}
  `).all(
        startDate, endDate,
        ...(req.user.role === 'location_manager' ? [req.user.location_id] : []),
        ...((req.user.role === 'scanner_operator' || req.user.role === 'file_handler') ? [req.user.id] : []),
        ...((req.user.role === 'super_admin' && location_id) ? [location_id] : [])
    );

    // Build a map: user_id -> { date -> record }
    const recordMap = {};
    records.forEach(r => {
        if (!recordMap[r.user_id]) recordMap[r.user_id] = {};
        recordMap[r.user_id][r.record_date] = { scan_count: r.scan_count, status: r.status, notes: r.notes };
    });

    // Generate dates for the month
    const dates = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayOfWeek = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
        dates.push({ date: dateStr, day: d, dayName: dayOfWeek });
    }

    // Build response
    const data = users.map(user => {
        const dailyData = {};
        dates.forEach(({ date }) => {
            dailyData[date] = recordMap[user.id]?.[date] || null;
        });
        return {
            user_id: user.id,
            full_name: user.full_name,
            role: user.role,
            scanner_id: user.scanner_id,
            location_name: user.location_name,
            location_name: user.location_name,
            salary_type: user.salary_type,
            custom_rate: user.custom_rate,
            fixed_salary: user.fixed_salary,
            daily: dailyData
        };
    });

    const scan_rate = db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get()?.value || 0.10;
    res.json({ month: m, year: y, dates, users: data, scan_rate: parseFloat(scan_rate) });
});

app.post('/api/records', authenticate, (req, res) => {
    const { user_id, record_date, scan_count, status, notes } = req.body;

    // Operators can only add their own records
    const targetUserId = (req.user.role === 'scanner_operator' || req.user.role === 'file_handler')
        ? req.user.id : user_id;

    if (!targetUserId || !record_date || !status) {
        return res.status(400).json({ error: 'user_id, record_date, and status are required' });
    }

    try {
        const result = db.prepare(`
      INSERT INTO daily_records (user_id, record_date, scan_count, status, notes, entered_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, record_date)
      DO UPDATE SET scan_count = excluded.scan_count, status = excluded.status, notes = excluded.notes, entered_by = excluded.entered_by, updated_at = CURRENT_TIMESTAMP
    `).run(targetUserId, record_date, scan_count || null, status, notes || null, req.user.id);
        res.json({ id: result.lastInsertRowid, message: 'Record saved successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk save records
app.post('/api/records/bulk', authenticate, authorize('super_admin', 'location_manager'), (req, res) => {
    const { records: recordsData } = req.body;
    if (!Array.isArray(recordsData)) return res.status(400).json({ error: 'records must be an array' });

    const stmt = db.prepare(`
    INSERT INTO daily_records (user_id, record_date, scan_count, status, notes, entered_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, record_date)
    DO UPDATE SET scan_count = excluded.scan_count, status = excluded.status, notes = excluded.notes, entered_by = excluded.entered_by, updated_at = CURRENT_TIMESTAMP
  `);

    const saveMany = db.transaction((items) => {
        for (const item of items) {
            stmt.run(item.user_id, item.record_date, item.scan_count || null, item.status || 'present', item.notes || null, req.user.id);
        }
    });

    try {
        saveMany(recordsData);
        res.json({ message: `${recordsData.length} records saved successfully` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================== ROLES ROUTES ===================

app.get('/api/roles', authenticate, (req, res) => {
    const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, display_name').all();
    res.json(roles);
});

app.post('/api/roles', authenticate, authorize('super_admin'), (req, res) => {
    const { role_id, display_name, description } = req.body;
    if (!role_id || !display_name) {
        return res.status(400).json({ error: 'Role ID and Display Name are required' });
    }
    // Validate role_id format (lowercase, no spaces)
    if (!/^[a-z_]+$/.test(role_id)) {
        return res.status(400).json({ error: 'Role ID must be lowercase letters and underscores only' });
    }
    try {
        const result = db.prepare('INSERT INTO roles (role_id, display_name, description, is_system) VALUES (?, ?, ?, 0)')
            .run(role_id, display_name, description || '');
        res.json({ id: result.lastInsertRowid, message: 'Role created successfully' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Role ID already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/roles/:id', authenticate, authorize('super_admin'), (req, res) => {
    const { display_name, description } = req.body;
    // Check if system role
    const role = db.prepare('SELECT is_system FROM roles WHERE id = ?').get(req.params.id);
    if (role && role.is_system) {
        return res.status(403).json({ error: 'Cannot modify system roles' });
    }
    db.prepare('UPDATE roles SET display_name = COALESCE(?, display_name), description = COALESCE(?, description) WHERE id = ?')
        .run(display_name, description, req.params.id);
    res.json({ message: 'Role updated successfully' });
});

app.delete('/api/roles/:id', authenticate, authorize('super_admin'), (req, res) => {
    const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
    if (!role) {
        return res.status(404).json({ error: 'Role not found' });
    }
    if (role.is_system) {
        return res.status(403).json({ error: 'Cannot delete system roles' });
    }
    // Check if role is in use
    const usersWithRole = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get(role.role_id);
    if (usersWithRole.count > 0) {
        return res.status(400).json({ error: `Cannot delete role. ${usersWithRole.count} users are using this role.` });
    }
    db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.id);
    res.json({ message: 'Role deleted successfully' });
});

// =================== SETTINGS ROUTES ===================

app.get('/api/settings', authenticate, (req, res) => {
    const settings = db.prepare('SELECT key, value FROM settings').all();
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    res.json(settingsMap);
});

app.put('/api/settings', authenticate, authorize('super_admin'), (req, res) => {
    const { scan_rate } = req.body;
    if (scan_rate !== undefined) {
        db.prepare("INSERT INTO settings (key, value) VALUES ('scan_rate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
            .run(String(scan_rate));
    }
    res.json({ message: 'Settings updated successfully' });
});

// =================== DASHBOARD/STATS ROUTES ===================

app.get('/api/dashboard/stats', authenticate, (req, res) => {
    const { location_id } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = today.substring(0, 7);

    let locationFilter = '';
    const params = [];

    if (req.user.role === 'location_manager') {
        locationFilter = 'AND u.location_id = ?';
        params.push(req.user.location_id);
    } else if (req.user.role === 'super_admin' && location_id) {
        locationFilter = 'AND u.location_id = ?';
        params.push(location_id);
    }

    // Total locations
    const totalLocations = db.prepare('SELECT COUNT(*) as count FROM locations WHERE is_active = 1').get().count;

    // Total active employees
    const totalEmployees = db.prepare(`SELECT COUNT(*) as count FROM users u WHERE u.is_active = 1 AND u.role != 'super_admin' ${locationFilter}`).get(...params).count;

    // Today's total scans
    const todayScans = db.prepare(`SELECT COALESCE(SUM(dr.scan_count), 0) as total FROM daily_records dr JOIN users u ON dr.user_id = u.id WHERE dr.record_date = ? AND dr.status = 'present' ${locationFilter}`).get(today, ...params).total;

    // Today's present count
    const todayPresent = db.prepare(`SELECT COUNT(*) as count FROM daily_records dr JOIN users u ON dr.user_id = u.id WHERE dr.record_date = ? AND dr.status = 'present' ${locationFilter}`).get(today, ...params).count;

    // Today's absent count
    const todayAbsent = db.prepare(`SELECT COUNT(*) as count FROM daily_records dr JOIN users u ON dr.user_id = u.id WHERE dr.record_date = ? AND dr.status = 'absent' ${locationFilter}`).get(today, ...params).count;

    // This month total scans
    const monthScans = db.prepare(`SELECT COALESCE(SUM(dr.scan_count), 0) as total FROM daily_records dr JOIN users u ON dr.user_id = u.id WHERE dr.record_date LIKE ? AND dr.status = 'present' ${locationFilter}`).get(currentMonth + '%', ...params).total;

    // Last 7 days trend
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const trend = db.prepare(`
    SELECT dr.record_date, COALESCE(SUM(dr.scan_count), 0) as total, COUNT(CASE WHEN dr.status = 'present' THEN 1 END) as present_count
    FROM daily_records dr JOIN users u ON dr.user_id = u.id
    WHERE dr.record_date >= ? ${locationFilter}
    GROUP BY dr.record_date ORDER BY dr.record_date
  `).all(sevenDaysAgo.toISOString().split('T')[0], ...params);

    // Top performers this month
    const topPerformers = db.prepare(`
    SELECT u.full_name, u.scanner_id, COALESCE(SUM(dr.scan_count), 0) as total_scans, COUNT(CASE WHEN dr.status = 'present' THEN 1 END) as days_present
    FROM daily_records dr JOIN users u ON dr.user_id = u.id
    WHERE dr.record_date LIKE ? AND dr.status = 'present' ${locationFilter}
    GROUP BY dr.user_id ORDER BY total_scans DESC LIMIT 5
  `).all(currentMonth + '%', ...params);

    // Global Rate
    const globalRate = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get()?.value || 0.10);
    const dateObj = new Date();
    const daysInCurrentMonth = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 0).getDate();

    // Today's Earnings
    const todayEarnings = db.prepare(`
        SELECT COALESCE(SUM(
            CASE 
                WHEN u.salary_type = 'fixed' THEN (COALESCE(u.fixed_salary, 0) / ?)
                ELSE (dr.scan_count * COALESCE(u.custom_rate, ?))
            END
        ), 0) as total
        FROM daily_records dr
        JOIN users u ON dr.user_id = u.id
        WHERE dr.record_date = ? AND dr.status = 'present' ${locationFilter}
    `).get(daysInCurrentMonth, globalRate, today, ...params).total;

    // Month Earnings
    const monthEarnings = db.prepare(`
        SELECT COALESCE(SUM(
            CASE 
                WHEN u.salary_type = 'fixed' THEN (COALESCE(u.fixed_salary, 0) / ?)
                ELSE (dr.scan_count * COALESCE(u.custom_rate, ?))
            END
        ), 0) as total
        FROM daily_records dr
        JOIN users u ON dr.user_id = u.id
        WHERE dr.record_date LIKE ? AND dr.status = 'present' ${locationFilter}
    `).get(daysInCurrentMonth, globalRate, currentMonth + '%', ...params).total;

    res.json({
        totalLocations,
        totalEmployees,
        todayScans,
        todayPresent,
        todayAbsent,
        monthScans,
        trend,
        topPerformers,
        scan_rate: globalRate,
        todayEarnings,
        monthEarnings
    });
});

// Get simple dashboard summary (location-wise)
app.get('/api/dashboard/simple', authenticate, (req, res) => {
    const { location_id } = req.query;
    const globalRate = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get()?.value || 0.10);

    // Get locations (filter if specified)
    let locationsQuery = `SELECT id, name, client_rate FROM locations WHERE is_active = 1`;
    if (location_id) {
        locationsQuery += ` AND id = ?`;
    }
    const locations = location_id
        ? db.prepare(locationsQuery).all(location_id)
        : db.prepare(locationsQuery).all();

    // Get all records with user info
    const allRecords = db.prepare(`
        SELECT
            u.location_id,
            u.salary_type,
            u.fixed_salary,
            u.custom_rate,
            dr.scan_count,
            dr.record_date
        FROM daily_records dr
        JOIN users u ON dr.user_id = u.id
        WHERE dr.status = 'present'
    `).all();

    // Get expenses per location
    const expensesByLocation = db.prepare(`
        SELECT location_id, COALESCE(SUM(amount), 0) as total_expenses
        FROM expenses
        GROUP BY location_id
    `).all();
    const expensesMap = {};
    expensesByLocation.forEach(e => expensesMap[e.location_id] = e.total_expenses);

    // Calculate per location
    const locationData = locations.map(loc => {
        const locRecords = allRecords.filter(r => r.location_id === loc.id);

        let totalScans = 0;
        let employeeCost = 0;

        locRecords.forEach(r => {
            totalScans += r.scan_count || 0;

            if (r.salary_type === 'fixed') {
                const recordDate = new Date(r.record_date);
                const daysInMonth = new Date(recordDate.getFullYear(), recordDate.getMonth() + 1, 0).getDate();
                employeeCost += (r.fixed_salary || 0) / daysInMonth;
            } else {
                const rate = r.custom_rate || globalRate;
                employeeCost += (r.scan_count || 0) * rate;
            }
        });

        const revenue = totalScans * (loc.client_rate || 0);
        const expenses = expensesMap[loc.id] || 0;

        return {
            location_id: loc.id,
            location_name: loc.name,
            client_rate: loc.client_rate || 0,
            total_scans: totalScans,
            employee_cost: Math.round(employeeCost),
            expenses: Math.round(expenses),
            revenue: Math.round(revenue)
        };
    });

    // Calculate totals
    const totals = {
        total_scans: locationData.reduce((sum, l) => sum + l.total_scans, 0),
        total_employee_cost: locationData.reduce((sum, l) => sum + l.employee_cost, 0),
        total_expenses: locationData.reduce((sum, l) => sum + l.expenses, 0),
        total_revenue: locationData.reduce((sum, l) => sum + l.revenue, 0)
    };

    res.json({ locations: locationData, totals });
});

// Get operator's own stats (for scanner_operator and file_handler)
app.get('/api/dashboard/my-stats', authenticate, (req, res) => {
    const userId = req.user.id;
    const globalRate = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get()?.value || 0.10);
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = today.substring(0, 7);

    // Get user info
    const user = db.prepare(`
        SELECT u.*, l.name as location_name
        FROM users u
        LEFT JOIN locations l ON u.location_id = l.id
        WHERE u.id = ?
    `).get(userId);

    // Today's record
    const todayRecord = db.prepare(`
        SELECT scan_count, status, notes
        FROM daily_records
        WHERE user_id = ? AND record_date = ?
    `).get(userId, today);

    // This month's total scans
    const monthScans = db.prepare(`
        SELECT COALESCE(SUM(scan_count), 0) as total
        FROM daily_records
        WHERE user_id = ? AND record_date LIKE ? AND status = 'present'
    `).get(userId, currentMonth + '%').total;

    // Calculate earnings
    let monthEarnings = 0;
    if (user.salary_type === 'fixed') {
        // For fixed salary, show monthly salary
        monthEarnings = user.fixed_salary || 0;
    } else {
        // For per-page, calculate based on scans
        const rate = user.custom_rate || globalRate;
        monthEarnings = monthScans * rate;
    }

    // All time total scans
    const allTimeScans = db.prepare(`
        SELECT COALESCE(SUM(scan_count), 0) as total
        FROM daily_records
        WHERE user_id = ? AND status = 'present'
    `).get(userId).total;

    // Days present this month
    const daysPresent = db.prepare(`
        SELECT COUNT(*) as count
        FROM daily_records
        WHERE user_id = ? AND record_date LIKE ? AND status = 'present'
    `).get(userId, currentMonth + '%').count;

    res.json({
        user: {
            full_name: user.full_name,
            role: user.role,
            location_name: user.location_name,
            scanner_id: user.scanner_id,
            salary_type: user.salary_type
        },
        today: {
            date: today,
            scan_count: todayRecord?.scan_count || 0,
            status: todayRecord?.status || 'not_entered',
            notes: todayRecord?.notes || ''
        },
        month: {
            total_scans: monthScans,
            earnings: Math.round(monthEarnings),
            days_present: daysPresent
        },
        all_time: {
            total_scans: allTimeScans
        }
    });
});

// Get location detail (employees and their earnings)
app.get('/api/dashboard/location/:id', authenticate, (req, res) => {
    const locationId = req.params.id;
    const globalRate = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get()?.value || 0.10);

    // Get location info
    const location = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(locationId);
    if (!location) {
        return res.status(404).json({ error: 'Location not found' });
    }

    // Get employees at this location
    const employees = db.prepare(`
        SELECT id, full_name, role, salary_type, custom_rate, fixed_salary
        FROM users
        WHERE location_id = ? AND is_active = 1 AND role != 'super_admin'
    `).all(locationId);

    // Get records for each employee
    const employeeData = employees.map(emp => {
        const records = db.prepare(`
            SELECT scan_count, record_date
            FROM daily_records
            WHERE user_id = ? AND status = 'present'
        `).all(emp.id);

        let totalScans = 0;
        let earnings = 0;

        records.forEach(r => {
            totalScans += r.scan_count || 0;

            if (emp.salary_type === 'fixed') {
                const recordDate = new Date(r.record_date);
                const daysInMonth = new Date(recordDate.getFullYear(), recordDate.getMonth() + 1, 0).getDate();
                earnings += (emp.fixed_salary || 0) / daysInMonth;
            } else {
                const rate = emp.custom_rate || globalRate;
                earnings += (r.scan_count || 0) * rate;
            }
        });

        return {
            id: emp.id,
            full_name: emp.full_name,
            role: emp.role,
            total_scans: totalScans,
            earnings: Math.round(earnings)
        };
    });

    // Get expenses for this location
    const expenses = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE location_id = ?`).get(locationId).total;

    // Calculate totals
    const totalScans = employeeData.reduce((sum, e) => sum + e.total_scans, 0);
    const totalCost = employeeData.reduce((sum, e) => sum + e.earnings, 0);
    const revenue = totalScans * (location.client_rate || 0);

    res.json({
        location,
        employees: employeeData,
        summary: {
            total_scans: totalScans,
            employee_cost: totalCost,
            expenses: Math.round(expenses),
            revenue: Math.round(revenue)
        }
    });
});

app.get('/api/dashboard/admin', authenticate, authorize('super_admin'), (req, res) => {
    const { month } = req.query; // Format: YYYY-MM
    const dateObj = new Date();
    const currentMonthStr = month || dateObj.toISOString().slice(0, 7);
    const year = parseInt(currentMonthStr.slice(0, 4));
    const m = parseInt(currentMonthStr.slice(5, 7));
    const daysInMonth = new Date(year, m, 0).getDate();
    const globalRate = parseFloat(db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get()?.value || 0.10);

    // 1. Revenue per Location
    const revenues = db.prepare(`
        SELECT 
            l.id as location_id,
            l.name as location_name,
            l.client_rate,
            SUM(dr.scan_count) as total_scans,
            SUM(dr.scan_count * COALESCE(l.client_rate, 0)) as total_revenue
        FROM daily_records dr
        JOIN users u ON dr.user_id = u.id
        JOIN locations l ON u.location_id = l.id
        WHERE strftime('%Y-%m', dr.record_date) = ?
        GROUP BY l.id
    `).all(currentMonthStr);

    // 2. Employee Cost per Location
    const costs = db.prepare(`
        SELECT 
            u.location_id,
            SUM(
                CASE 
                    WHEN u.salary_type = 'fixed' THEN (COALESCE(u.fixed_salary, 0) / ?) * (
                        SELECT COUNT(DISTINCT dr_sub.record_date) 
                        FROM daily_records dr_sub 
                        WHERE dr_sub.user_id = u.id 
                        AND dr_sub.status = 'present' 
                        AND strftime('%Y-%m', dr_sub.record_date) = ?
                    )
                    ELSE (
                         SELECT SUM(dr_sub.scan_count) 
                         FROM daily_records dr_sub 
                         WHERE dr_sub.user_id = u.id 
                         AND strftime('%Y-%m', dr_sub.record_date) = ?
                    ) * COALESCE(u.custom_rate, ?)
                END
            ) as total_cost
        FROM users u
        WHERE u.role != 'super_admin'
        GROUP BY u.location_id
    `).all(daysInMonth, currentMonthStr, currentMonthStr, globalRate);

    // Note: The cost query above is complex (correlated subqueries). 
    // Simplified logic: JOIN daily_records and aggregate.
    // Re-writing cost query to be simpler and safer.

    // 3. Expenses
    const expenses = db.prepare(`
        SELECT location_id, SUM(amount) as total_expense
        FROM expenses
        WHERE strftime('%Y-%m', expense_date) = ?
        GROUP BY location_id
    `).all(currentMonthStr);

    // Combine
    const combined = revenues.map(r => {
        // Find cost for this location
        // We need a better cost query. See below.
        return r;
    });

    // ... I will use JS to combine correctly.
    // Fetch simpler cost data:
    const locCosts = db.prepare(`
        SELECT 
            u.location_id,
            u.salary_type,
            u.fixed_salary,
            u.custom_rate,
            dr.user_id,
            dr.record_date,
            dr.scan_count,
            dr.status
        FROM daily_records dr
        JOIN users u ON dr.user_id = u.id
        WHERE strftime('%Y-%m', dr.record_date) = ?
    `).all(currentMonthStr);

    const costMap = {};
    locCosts.forEach(r => {
        if (!costMap[r.location_id]) costMap[r.location_id] = 0;
        let cost = 0;
        if (r.salary_type === 'fixed') {
            if (r.status === 'present') {
                cost = (r.fixed_salary || 0) / daysInMonth;
            }
        } else {
            const rate = r.custom_rate || globalRate;
            cost = r.scan_count * rate;
        }
        costMap[r.location_id] += cost;
    });

    const projectStats = revenues.map(r => {
        const laborCost = costMap[r.location_id] || 0;
        const expObj = expenses.find(e => e.location_id === r.location_id);
        const expense = expObj ? expObj.total_expense : 0;

        return {
            location_id: r.location_id,
            location_name: r.location_name,
            client_rate: r.client_rate,
            total_scans: r.total_scans,
            revenue: Math.round(r.total_revenue),
            labour_cost: Math.round(laborCost),
            expenses: Math.round(expense),
            profit: Math.round(r.total_revenue - laborCost - expense)
        };
    });

    res.json({ month: currentMonthStr, project_stats: projectStats });
});
app.use((req, res, next) => {
    if (!req.path.startsWith('/api') && req.method === 'GET') {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        next();
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 Scanning Tracker running at http://localhost:${PORT}`);
    console.log(`📋 Default login: username = admin, password = admin123\n`);
    scheduleDailyBackup();
});
