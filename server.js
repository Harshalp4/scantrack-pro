const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const { db, initDatabase } = require('./database');

// Azure Blob Storage configuration
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const AZURE_CONTAINER_NAME = 'scantrack-expenses';
const { generateBlobSASQueryParameters, BlobSASPermissions, StorageSharedKeyCredential } = require('@azure/storage-blob');

// Helper to parse connection string
function parseConnectionString(connStr) {
    const parts = {};
    if (!connStr) return parts;
    connStr.split(';').forEach(part => {
        const [key, ...valueParts] = part.split('=');
        if (key && valueParts.length) {
            parts[key] = valueParts.join('=');
        }
    });
    return parts;
}

// Initialize Azure Blob Service Client
let blobServiceClient;
let containerClient;
let sharedKeyCredential;

async function initAzureStorage() {
    if (!AZURE_STORAGE_CONNECTION_STRING) {
        console.log('⚠️  Azure Blob Storage not configured');
        return;
    }
    try {
        blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        containerClient = blobServiceClient.getContainerClient(AZURE_CONTAINER_NAME);

        // Extract account name and key from connection string for SAS generation
        const connParts = parseConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        const accountName = connParts.AccountName;
        const accountKey = connParts.AccountKey;
        sharedKeyCredential = new StorageSharedKeyCredential(accountName, accountKey);

        // Create container if it doesn't exist (private - no public access)
        await containerClient.createIfNotExists();
        console.log('✅ Azure Blob Storage connected (Container: ' + AZURE_CONTAINER_NAME + ')');
    } catch (err) {
        console.error('❌ Azure Blob Storage connection failed:', err.message);
    }
}

// Generate SAS URL for blob (valid for 1 year)
function generateSasUrl(blobName) {
    const blobClient = containerClient.getBlobClient(blobName);

    const sasOptions = {
        containerName: AZURE_CONTAINER_NAME,
        blobName: blobName,
        permissions: BlobSASPermissions.parse('r'), // Read only
        startsOn: new Date(),
        expiresOn: new Date(new Date().valueOf() + 365 * 24 * 60 * 60 * 1000), // 1 year
    };

    const sasToken = generateBlobSASQueryParameters(sasOptions, sharedKeyCredential).toString();
    return `${blobClient.url}?${sasToken}`;
}

// Upload file to Azure Blob Storage
async function uploadToAzure(fileBuffer, fileName, mimeType) {
    const blockBlobClient = containerClient.getBlockBlobClient(fileName);
    await blockBlobClient.uploadData(fileBuffer, {
        blobHTTPHeaders: { blobContentType: mimeType }
    });
    // Return SAS URL for private container access
    return generateSasUrl(fileName);
}

// Delete file from Azure Blob Storage
async function deleteFromAzure(blobUrl) {
    try {
        // Extract blob name from URL (remove SAS token if present)
        const urlWithoutSas = blobUrl.split('?')[0];
        const urlParts = new URL(urlWithoutSas);
        const pathParts = urlParts.pathname.split('/');
        const blobName = pathParts[pathParts.length - 1];
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.deleteIfExists();
        return true;
    } catch (err) {
        console.error('Error deleting blob:', err.message);
        return false;
    }
}

// Configure multer to use memory storage (for Azure upload)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|pdf|gif/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Only images (jpeg, jpg, png, gif) and PDF files are allowed'));
        }
    }
});

const app = express();
const PORT = process.env.PORT || 3500;
const JWT_SECRET = process.env.JWT_SECRET || 'scanning-tracker-secret-key-2026';

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

// =================== HEALTH CHECK ===================

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Self-ping to keep Render awake (runs every 14 minutes)
if (process.env.RENDER_EXTERNAL_URL || process.env.RENDER) {
    setInterval(() => {
        const url = process.env.RENDER_EXTERNAL_URL || 'https://scantrack-pro.onrender.com';
        fetch(`${url}/health`).catch(() => {});
        console.log('🏓 Self-ping to stay awake');
    }, 14 * 60 * 1000); // 14 minutes
}

app.get('/', (req, res, next) => {
    if (req.headers.accept && req.headers.accept.includes('text/html')) {
        next(); // Let static files handle it
    } else {
        res.status(200).json({ status: 'ok', app: 'ScanTrack Pro' });
    }
});

// =================== AUTH ROUTES ===================

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        // Username is case-insensitive, password remains case-sensitive
        const user = await db.prepare('SELECT u.*, l.name as location_name FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE LOWER(u.username) = LOWER(?) AND u.is_active = 1').get(username);
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    try {
        const user = await db.prepare('SELECT u.id, u.username, u.full_name, u.role, u.location_id, u.scanner_id, u.salary_type, u.custom_rate, u.fixed_salary, l.name as location_name FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE u.id = ?').get(req.user.id);
        // Get global scan rate for per_page employees
        const scanRateSetting = await db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get();
        user.scan_rate = user.custom_rate || parseFloat(scanRateSetting?.value || 0.10);
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const user = await db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
        if (!bcrypt.compareSync(currentPassword, user.password)) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }
        const hashed = bcrypt.hashSync(newPassword, 10);
        await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.user.id);
        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================== LOCATION ROUTES ===================

app.get('/api/locations', authenticate, async (req, res) => {
    try {
        let locations;
        if (req.user.role === 'super_admin') {
            locations = await db.prepare('SELECT * FROM locations ORDER BY name').all();
        } else {
            locations = await db.prepare('SELECT * FROM locations WHERE id = ? AND is_active = 1').all(req.user.location_id);
        }
        // Add employee count for each location
        for (let i = 0; i < locations.length; i++) {
            const count = await db.prepare('SELECT COUNT(*) as count FROM users WHERE location_id = ? AND role != ? AND is_active = 1').get(locations[i].id, 'super_admin');
            locations[i].employee_count = count.count;
        }
        res.json(locations);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/locations', authenticate, authorize('super_admin'), async (req, res) => {
    const { name, address, client_rate } = req.body;
    if (!name) return res.status(400).json({ error: 'Location name is required' });
    try {
        const result = await db.prepare('INSERT INTO locations (name, address, client_rate) VALUES (?, ?, ?)').run(name, address || '', client_rate || 0);
        res.json({ id: result.lastInsertRowid, name, address, client_rate, message: 'Location created successfully' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Location name already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/locations/:id', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const { name, address, is_active, client_rate } = req.body;
        await db.prepare('UPDATE locations SET name = COALESCE(?, name), address = COALESCE(?, address), is_active = COALESCE(?, is_active), client_rate = COALESCE(?, client_rate) WHERE id = ?').run(name, address, is_active, client_rate, req.params.id);
        res.json({ message: 'Location updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/locations/:id', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const permanent = req.query.permanent === 'true';

        if (permanent) {
            // Check if location has any employees
            const employees = await db.prepare('SELECT COUNT(*) as count FROM users WHERE location_id = ?').get(req.params.id);
            if (employees.count > 0) {
                return res.status(400).json({ error: `Cannot delete: ${employees.count} employee(s) are assigned to this location. Please reassign them first.` });
            }

            // Check if location has any expenses
            const expenses = await db.prepare('SELECT COUNT(*) as count FROM expenses WHERE location_id = ?').get(req.params.id);
            if (expenses.count > 0) {
                return res.status(400).json({ error: `Cannot delete: ${expenses.count} expense(s) are recorded for this location. Please delete or reassign them first.` });
            }

            // Check if location has any daily records (via users)
            const records = await db.prepare(`
                SELECT COUNT(*) as count FROM daily_records dr
                JOIN users u ON dr.user_id = u.id
                WHERE u.location_id = ?
            `).get(req.params.id);
            if (records.count > 0) {
                return res.status(400).json({ error: `Cannot delete: ${records.count} daily record(s) exist for employees at this location.` });
            }

            // Permanently delete
            await db.prepare('DELETE FROM locations WHERE id = ?').run(req.params.id);
            res.json({ message: 'Location permanently deleted' });
        } else {
            // Soft delete (deactivate)
            await db.prepare('UPDATE locations SET is_active = 0 WHERE id = ?').run(req.params.id);
            res.json({ message: 'Location deactivated' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================== EXPENSES ROUTES ===================

app.get('/api/expenses', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const { location_id, start_date, end_date } = req.query;
        let sql = `SELECT e.*, l.name as location_name FROM expenses e JOIN locations l ON e.location_id = l.id WHERE 1=1`;
        const params = [];

        if (location_id) {
            sql += ' AND e.location_id = ?';
            params.push(location_id);
        }
        if (start_date && end_date) {
            sql += ' AND e.expense_date BETWEEN ? AND ?';
            params.push(start_date, end_date);
        }
        sql += ' ORDER BY e.expense_date DESC';
        const expenses = await db.prepare(sql).all(...params);
        res.json(expenses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/expenses', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const { location_id, expense_date, amount, description, document_url, paid_by } = req.body;
        if (!location_id || !expense_date || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const result = await db.prepare('INSERT INTO expenses (location_id, expense_date, amount, description, document_url, paid_by) VALUES (?, ?, ?, ?, ?, ?)').run(location_id, expense_date, amount, description || '', document_url || null, paid_by || null);
        res.json({ id: result.lastInsertRowid, message: 'Expense added' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/expenses/:id', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        // Get the expense to delete any associated document from Azure
        const expense = await db.prepare('SELECT document_url FROM expenses WHERE id = ?').get(req.params.id);
        if (expense?.document_url) {
            await deleteFromAzure(expense.document_url);
        }
        await db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
        res.json({ message: 'Expense deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update expense
app.put('/api/expenses/:id', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const { location_id, expense_date, amount, description, document_url, paid_by } = req.body;
        if (!location_id || !expense_date || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        await db.prepare('UPDATE expenses SET location_id = ?, expense_date = ?, amount = ?, description = ?, document_url = ?, paid_by = ? WHERE id = ?')
            .run(location_id, expense_date, amount, description || '', document_url || null, paid_by || null, req.params.id);
        res.json({ message: 'Expense updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upload expense document to Azure Blob Storage
app.post('/api/expenses/upload', authenticate, authorize('super_admin'), upload.single('document'), async (req, res) => {
    try {
        if (!containerClient) {
            return res.status(503).json({ error: 'Azure storage not configured' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        // Generate unique filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(req.file.originalname);
        const fileName = 'expense-' + uniqueSuffix + ext;

        // Upload to Azure Blob Storage
        const documentUrl = await uploadToAzure(req.file.buffer, fileName, req.file.mimetype);
        res.json({ document_url: documentUrl, message: 'Document uploaded' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete expense document from Azure Blob Storage
app.delete('/api/expenses/:id/document', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const expense = await db.prepare('SELECT document_url FROM expenses WHERE id = ?').get(req.params.id);
        if (expense?.document_url) {
            await deleteFromAzure(expense.document_url);
            await db.prepare('UPDATE expenses SET document_url = NULL WHERE id = ?').run(req.params.id);
        }
        res.json({ message: 'Document deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================== USER/EMPLOYEE ROUTES ===================

app.get('/api/users', authenticate, async (req, res) => {
    try {
        const { location_id, role } = req.query;
        let sql = `SELECT u.id, u.username, u.full_name, u.role, u.location_id, u.scanner_id, u.is_active, u.created_at, l.name as location_name, u.salary_type, u.custom_rate, u.fixed_salary FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE 1=1`;
        const params = [];

        if (req.user.role !== 'super_admin') {
            sql += ' AND u.location_id = ?';
            params.push(req.user.location_id);
        } else if (location_id) {
            sql += ' AND u.location_id = ?';
            params.push(location_id);
        }

        if (role) {
            sql += ' AND u.role = ?';
            params.push(role);
        }

        sql += ' AND u.role != ? AND u.is_active = 1 ORDER BY u.full_name';
        params.push('super_admin');

        const users = await db.prepare(sql).all(...params);
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/users', authenticate, authorize('super_admin', 'location_manager'), async (req, res) => {
    const { username, password, full_name, role, location_id, scanner_id, daily_target } = req.body;
    if (!username || !password || !full_name || !role) {
        return res.status(400).json({ error: 'All fields are required' });
    }

    const targetLocationId = req.user.role === 'super_admin' ? location_id : req.user.location_id;

    if (role === 'super_admin' && req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'Cannot create super admin' });
    }

    try {
        const hashed = bcrypt.hashSync(password, 10);
        const result = await db.prepare('INSERT INTO users (username, password, full_name, role, location_id, scanner_id, salary_type, custom_rate, fixed_salary, daily_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(username, hashed, full_name, role, targetLocationId, scanner_id || null, req.body.salary_type || 'per_page', req.body.custom_rate || null, req.body.fixed_salary || null, daily_target || null);
        res.json({ id: result.lastInsertRowid, message: 'User created successfully' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/:id', authenticate, authorize('super_admin', 'location_manager'), async (req, res) => {
    try {
        const { full_name, username, role, scanner_id, is_active, password, daily_target } = req.body;

        if (req.user.role === 'location_manager') {
            const targetUser = await db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.params.id);
            if (!targetUser || targetUser.location_id !== req.user.location_id) {
                return res.status(403).json({ error: 'You can only edit employees at your location' });
            }
            if (role === 'location_manager' || role === 'super_admin') {
                return res.status(403).json({ error: 'You cannot assign this role' });
            }
        }

        if (password) {
            const hashed = bcrypt.hashSync(password, 10);
            await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.params.id);
        }

        // Check if username is being changed and if it's unique
        if (username) {
            const existingUser = await db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
            if (existingUser) {
                return res.status(400).json({ error: 'Username already exists' });
            }
        }

        await db.prepare(`UPDATE users SET full_name = COALESCE(?, full_name), username = COALESCE(?, username), role = COALESCE(?, role), scanner_id = COALESCE(?, scanner_id), is_active = COALESCE(?, is_active), salary_type = COALESCE(?, salary_type), custom_rate = COALESCE(?, custom_rate), fixed_salary = COALESCE(?, fixed_salary), daily_target = COALESCE(?, daily_target) WHERE id = ?`).run(full_name, username, role, scanner_id, is_active, req.body.salary_type, req.body.custom_rate, req.body.fixed_salary, daily_target, req.params.id);
        res.json({ message: 'User updated successfully' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/users/:id', authenticate, authorize('super_admin', 'location_manager'), async (req, res) => {
    try {
        if (req.user.role === 'location_manager') {
            const targetUser = await db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.params.id);
            if (!targetUser || targetUser.location_id !== req.user.location_id) {
                return res.status(403).json({ error: 'You can only deactivate employees at your location' });
            }
        }
        await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(req.params.id);
        res.json({ message: 'User deactivated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reset password for a single user (admin only)
app.post('/api/users/:id/reset-password', authenticate, authorize('super_admin', 'location_manager'), async (req, res) => {
    try {
        const { new_password } = req.body;
        if (!new_password || new_password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }

        if (req.user.role === 'location_manager') {
            const targetUser = await db.prepare('SELECT location_id FROM users WHERE id = ?').get(req.params.id);
            if (!targetUser || targetUser.location_id !== req.user.location_id) {
                return res.status(403).json({ error: 'You can only reset passwords for employees at your location' });
            }
        }

        const hashed = bcrypt.hashSync(new_password, 10);
        await db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.params.id);
        res.json({ message: 'Password reset successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk reset passwords for multiple users
app.post('/api/users/bulk-reset-password', authenticate, authorize('super_admin', 'location_manager'), async (req, res) => {
    try {
        const { user_ids, new_password, location_id } = req.body;

        if (!new_password || new_password.length < 4) {
            return res.status(400).json({ error: 'Password must be at least 4 characters' });
        }

        const hashed = bcrypt.hashSync(new_password, 10);
        let count = 0;

        // If location_id provided, reset all users at that location
        if (location_id && !user_ids) {
            const targetLocationId = req.user.role === 'super_admin' ? location_id : req.user.location_id;
            const result = await db.prepare('UPDATE users SET password = ? WHERE location_id = ? AND role != ? AND is_active = 1').run(hashed, targetLocationId, 'super_admin');
            count = result.changes;
        }
        // If specific user_ids provided
        else if (Array.isArray(user_ids) && user_ids.length > 0) {
            for (const userId of user_ids) {
                if (req.user.role === 'location_manager') {
                    const targetUser = await db.prepare('SELECT location_id FROM users WHERE id = ?').get(userId);
                    if (!targetUser || targetUser.location_id !== req.user.location_id) {
                        continue; // Skip users not in manager's location
                    }
                }
                await db.prepare('UPDATE users SET password = ? WHERE id = ? AND role != ?').run(hashed, userId, 'super_admin');
                count++;
            }
        } else {
            return res.status(400).json({ error: 'Provide either user_ids array or location_id' });
        }

        res.json({ message: `Password reset for ${count} users` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================== DAILY RECORDS ROUTES ===================

app.get('/api/records', authenticate, async (req, res) => {
    try {
        const { location_id, user_id, start_date, end_date, month, year } = req.query;

        let sql = `SELECT dr.*, u.full_name, u.scanner_id, u.role as user_role, l.name as location_name FROM daily_records dr JOIN users u ON dr.user_id = u.id LEFT JOIN locations l ON u.location_id = l.id WHERE 1=1`;
        const params = [];

        if (req.user.role === 'scanner_operator' || req.user.role === 'file_handler') {
            sql += ' AND dr.user_id = ?';
            params.push(req.user.id);
        } else if (req.user.role === 'location_manager') {
            sql += ' AND u.location_id = ?';
            params.push(req.user.location_id);
        } else if (location_id) {
            sql += ' AND u.location_id = ?';
            params.push(location_id);
        }

        if (user_id) {
            sql += ' AND dr.user_id = ?';
            params.push(user_id);
        }

        if (start_date && end_date) {
            sql += ' AND dr.record_date BETWEEN ? AND ?';
            params.push(start_date, end_date);
        } else if (month && year) {
            const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
            const endOfMonth = new Date(year, month, 0).toISOString().split('T')[0];
            sql += ' AND dr.record_date BETWEEN ? AND ?';
            params.push(startOfMonth, endOfMonth);
        }

        sql += ' ORDER BY dr.record_date DESC, u.full_name';
        const records = await db.prepare(sql).all(...params);
        res.json(records);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/records/monthly', authenticate, async (req, res) => {
    try {
        const { location_id, month, year } = req.query;
        const m = parseInt(month) || new Date().getMonth() + 1;
        const y = parseInt(year) || new Date().getFullYear();
        const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
        const daysInMonth = new Date(y, m, 0).getDate();
        const endDate = `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;

        let usersQuery = 'SELECT u.id, u.full_name, u.role, u.scanner_id, u.location_id, u.salary_type, u.custom_rate, u.fixed_salary, u.daily_target, l.name as location_name FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE u.is_active = 1 AND u.role != ?';
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
        const users = await db.prepare(usersQuery).all(...usersParams);

        let recordsQuery = `SELECT dr.user_id, dr.record_date, dr.scan_count, dr.status, dr.notes FROM daily_records dr JOIN users u ON dr.user_id = u.id WHERE dr.record_date BETWEEN ? AND ?`;
        const recordsParams = [startDate, endDate];

        if (req.user.role === 'location_manager') {
            recordsQuery += ' AND u.location_id = ?';
            recordsParams.push(req.user.location_id);
        } else if (req.user.role === 'scanner_operator' || req.user.role === 'file_handler') {
            recordsQuery += ' AND dr.user_id = ?';
            recordsParams.push(req.user.id);
        } else if (location_id) {
            recordsQuery += ' AND u.location_id = ?';
            recordsParams.push(location_id);
        }

        const records = await db.prepare(recordsQuery).all(...recordsParams);

        const recordMap = {};
        records.forEach(r => {
            if (!recordMap[r.user_id]) recordMap[r.user_id] = {};
            recordMap[r.user_id][r.record_date] = { scan_count: r.scan_count, status: r.status, notes: r.notes };
        });

        const dates = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const dayOfWeek = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short' });
            dates.push({ date: dateStr, day: d, dayName: dayOfWeek });
        }

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
                salary_type: user.salary_type,
                custom_rate: user.custom_rate,
                fixed_salary: user.fixed_salary,
                daily_target: user.daily_target,
                daily: dailyData
            };
        });

        const scanRateSetting = await db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get();
        const scan_rate = scanRateSetting?.value || 0.10;
        res.json({ month: m, year: y, dates, users: data, scan_rate: parseFloat(scan_rate) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/records', authenticate, async (req, res) => {
    try {
        const { user_id, record_date, scan_count, status, notes } = req.body;

        const targetUserId = (req.user.role === 'scanner_operator' || req.user.role === 'file_handler')
            ? req.user.id : user_id;

        if (!targetUserId || !record_date || !status) {
            return res.status(400).json({ error: 'user_id, record_date, and status are required' });
        }

        // Check if record exists
        const existing = await db.prepare('SELECT id FROM daily_records WHERE user_id = ? AND record_date = ?').get(targetUserId, record_date);

        if (existing) {
            await db.prepare('UPDATE daily_records SET scan_count = ?, status = ?, notes = ?, entered_by = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND record_date = ?').run(scan_count || null, status, notes || null, req.user.id, targetUserId, record_date);
        } else {
            await db.prepare('INSERT INTO daily_records (user_id, record_date, scan_count, status, notes, entered_by) VALUES (?, ?, ?, ?, ?, ?)').run(targetUserId, record_date, scan_count || null, status, notes || null, req.user.id);
        }
        res.json({ message: 'Record saved successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/records/bulk', authenticate, authorize('super_admin', 'location_manager'), async (req, res) => {
    try {
        const { records: recordsData } = req.body;
        if (!Array.isArray(recordsData)) return res.status(400).json({ error: 'records must be an array' });

        for (const item of recordsData) {
            const existing = await db.prepare('SELECT id FROM daily_records WHERE user_id = ? AND record_date = ?').get(item.user_id, item.record_date);

            if (existing) {
                await db.prepare('UPDATE daily_records SET scan_count = ?, status = ?, notes = ?, entered_by = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND record_date = ?').run(item.scan_count || null, item.status || 'present', item.notes || null, req.user.id, item.user_id, item.record_date);
            } else {
                await db.prepare('INSERT INTO daily_records (user_id, record_date, scan_count, status, notes, entered_by) VALUES (?, ?, ?, ?, ?, ?)').run(item.user_id, item.record_date, item.scan_count || null, item.status || 'present', item.notes || null, req.user.id);
            }
        }
        res.json({ message: `${recordsData.length} records saved successfully` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================== ROLES ROUTES ===================

app.get('/api/roles', authenticate, async (req, res) => {
    try {
        const roles = await db.prepare('SELECT * FROM roles ORDER BY is_system DESC, display_name').all();
        res.json(roles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/roles', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const { role_id, display_name, description } = req.body;
        if (!role_id || !display_name) {
            return res.status(400).json({ error: 'Role ID and Display Name are required' });
        }
        if (!/^[a-z_]+$/.test(role_id)) {
            return res.status(400).json({ error: 'Role ID must be lowercase letters and underscores only' });
        }
        const result = await db.prepare('INSERT INTO roles (role_id, display_name, description, is_system) VALUES (?, ?, ?, 0)').run(role_id, display_name, description || '');
        res.json({ id: result.lastInsertRowid, message: 'Role created successfully' });
    } catch (err) {
        if (err.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Role ID already exists' });
        }
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/roles/:id', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const { display_name, description } = req.body;
        const role = await db.prepare('SELECT is_system FROM roles WHERE id = ?').get(req.params.id);
        if (role && role.is_system) {
            return res.status(403).json({ error: 'Cannot modify system roles' });
        }
        await db.prepare('UPDATE roles SET display_name = COALESCE(?, display_name), description = COALESCE(?, description) WHERE id = ?').run(display_name, description, req.params.id);
        res.json({ message: 'Role updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/roles/:id', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const role = await db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.id);
        if (!role) {
            return res.status(404).json({ error: 'Role not found' });
        }
        if (role.is_system) {
            return res.status(403).json({ error: 'Cannot delete system roles' });
        }
        const usersWithRole = await db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get(role.role_id);
        if (usersWithRole.count > 0) {
            return res.status(400).json({ error: `Cannot delete role. ${usersWithRole.count} users are using this role.` });
        }
        await db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.id);
        res.json({ message: 'Role deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================== SETTINGS ROUTES ===================

app.get('/api/settings', authenticate, async (req, res) => {
    try {
        const settings = await db.prepare('SELECT key, value FROM settings').all();
        const settingsMap = {};
        settings.forEach(s => settingsMap[s.key] = s.value);
        res.json(settingsMap);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/settings', authenticate, authorize('super_admin'), async (req, res) => {
    try {
        const { scan_rate } = req.body;
        if (scan_rate !== undefined) {
            const existing = await db.prepare("SELECT key FROM settings WHERE key = 'scan_rate'").get();
            if (existing) {
                await db.prepare("UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'scan_rate'").run(String(scan_rate));
            } else {
                await db.prepare("INSERT INTO settings (key, value) VALUES ('scan_rate', ?)").run(String(scan_rate));
            }
        }
        res.json({ message: 'Settings updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =================== DASHBOARD/STATS ROUTES ===================

app.get('/api/dashboard/simple', authenticate, async (req, res) => {
    try {
        const { location_id, start_date, end_date } = req.query;
        const scanRateSetting = await db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get();
        const globalRate = parseFloat(scanRateSetting?.value || 0.10);

        let locationsQuery = `SELECT id, name, client_rate FROM locations WHERE is_active = 1`;
        const locations = location_id
            ? await db.prepare(locationsQuery + ' AND id = ?').all(location_id)
            : await db.prepare(locationsQuery).all();

        // Build date filter for records
        let recordsDateFilter = '';
        const recordsParams = [];
        if (start_date && end_date) {
            recordsDateFilter = ' AND dr.record_date BETWEEN ? AND ?';
            recordsParams.push(start_date, end_date);
        }

        const allRecords = await db.prepare(`
            SELECT u.location_id, u.salary_type, u.fixed_salary, u.custom_rate, dr.scan_count, dr.record_date
            FROM daily_records dr
            JOIN users u ON dr.user_id = u.id
            WHERE dr.status = 'present'${recordsDateFilter}
        `).all(...recordsParams);

        // Build date filter for expenses
        let expensesDateFilter = '';
        const expensesParams = [];
        if (start_date && end_date) {
            expensesDateFilter = ' WHERE expense_date BETWEEN ? AND ?';
            expensesParams.push(start_date, end_date);
        }

        const expensesByLocation = await db.prepare(`
            SELECT location_id, COALESCE(SUM(amount), 0) as total_expenses
            FROM expenses${expensesDateFilter} GROUP BY location_id
        `).all(...expensesParams);
        const expensesMap = {};
        expensesByLocation.forEach(e => expensesMap[e.location_id] = e.total_expenses);

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

        const totals = {
            total_scans: locationData.reduce((sum, l) => sum + l.total_scans, 0),
            total_employee_cost: locationData.reduce((sum, l) => sum + l.employee_cost, 0),
            total_expenses: locationData.reduce((sum, l) => sum + l.expenses, 0),
            total_revenue: locationData.reduce((sum, l) => sum + l.revenue, 0)
        };

        res.json({ locations: locationData, totals });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/my-stats', authenticate, async (req, res) => {
    try {
        const userId = req.user.id;
        const scanRateSetting = await db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get();
        const globalRate = parseFloat(scanRateSetting?.value || 0.10);
        const today = new Date().toISOString().split('T')[0];
        const currentMonth = today.substring(0, 7);

        const user = await db.prepare(`SELECT u.*, l.name as location_name FROM users u LEFT JOIN locations l ON u.location_id = l.id WHERE u.id = ?`).get(userId);

        const todayRecord = await db.prepare(`SELECT scan_count, status, notes FROM daily_records WHERE user_id = ? AND record_date = ?`).get(userId, today);

        const monthScansResult = await db.prepare(`SELECT COALESCE(SUM(scan_count), 0) as total FROM daily_records WHERE user_id = ? AND record_date LIKE ? AND status = 'present'`).get(userId, currentMonth + '%');
        const monthScans = monthScansResult?.total || 0;

        let monthEarnings = 0;
        if (user.salary_type === 'fixed') {
            monthEarnings = user.fixed_salary || 0;
        } else {
            const rate = user.custom_rate || globalRate;
            monthEarnings = monthScans * rate;
        }

        const allTimeScansResult = await db.prepare(`SELECT COALESCE(SUM(scan_count), 0) as total FROM daily_records WHERE user_id = ? AND status = 'present'`).get(userId);
        const allTimeScans = allTimeScansResult?.total || 0;

        const daysPresentResult = await db.prepare(`SELECT COUNT(*) as count FROM daily_records WHERE user_id = ? AND record_date LIKE ? AND status = 'present'`).get(userId, currentMonth + '%');
        const daysPresent = daysPresentResult?.count || 0;

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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/location/:id', authenticate, async (req, res) => {
    try {
        const locationId = req.params.id;
        const { start_date, end_date } = req.query;
        const scanRateSetting = await db.prepare("SELECT value FROM settings WHERE key = 'scan_rate'").get();
        const globalRate = parseFloat(scanRateSetting?.value || 0.10);

        const location = await db.prepare(`SELECT * FROM locations WHERE id = ?`).get(locationId);
        if (!location) {
            return res.status(404).json({ error: 'Location not found' });
        }

        // Get all employees at this location
        const employees = await db.prepare(`SELECT id, full_name, role, salary_type, custom_rate, fixed_salary FROM users WHERE location_id = ? AND is_active = 1 AND role != 'super_admin'`).all(locationId);

        // Build date filter
        let dateFilter = '';
        const dateParams = [];
        if (start_date && end_date) {
            dateFilter = ' AND dr.record_date BETWEEN ? AND ?';
            dateParams.push(start_date, end_date);
        }

        // Get all records for all employees in ONE query (optimized)
        const allRecords = await db.prepare(`
            SELECT dr.user_id, dr.scan_count, dr.record_date
            FROM daily_records dr
            JOIN users u ON dr.user_id = u.id
            WHERE u.location_id = ? AND dr.status = 'present'${dateFilter}
        `).all(locationId, ...dateParams);

        // Group records by user_id for fast lookup
        const recordsByUser = {};
        allRecords.forEach(r => {
            if (!recordsByUser[r.user_id]) recordsByUser[r.user_id] = [];
            recordsByUser[r.user_id].push(r);
        });

        // Calculate employee data
        const employeeData = employees.map(emp => {
            const records = recordsByUser[emp.id] || [];
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

        // Get expenses with date filter
        let expensesSql = `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE location_id = ?`;
        const expensesParams = [locationId];
        if (start_date && end_date) {
            expensesSql += ' AND expense_date BETWEEN ? AND ?';
            expensesParams.push(start_date, end_date);
        }
        const expensesResult = await db.prepare(expensesSql).get(...expensesParams);
        const expenses = expensesResult?.total || 0;

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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fallback for SPA
app.use((req, res, next) => {
    if (!req.path.startsWith('/api') && req.method === 'GET') {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        next();
    }
});

// Start server after database init
async function startServer() {
    try {
        await initDatabase();
        await initAzureStorage();
        app.listen(PORT, () => {
            console.log(`\n🚀 Scanning Tracker running at http://localhost:${PORT}`);
            console.log(`📋 Default login: username = admin, password = admin123\n`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();
