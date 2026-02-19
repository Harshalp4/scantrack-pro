const fs = require('fs');
const path = require('path');

// Configuration
const DB_PATH = path.join(__dirname, 'data', 'scanning.db');
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 30; // Keep last 30 backups

// Create backup directory if not exists
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function createBackup() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFileName = `scanning_backup_${timestamp}.db`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);

    try {
        // Check if source database exists
        if (!fs.existsSync(DB_PATH)) {
            console.error('❌ Database file not found:', DB_PATH);
            return null;
        }

        // Copy database file
        fs.copyFileSync(DB_PATH, backupPath);

        // Also copy WAL and SHM files if they exist (for consistency)
        const walPath = DB_PATH + '-wal';
        const shmPath = DB_PATH + '-shm';

        if (fs.existsSync(walPath)) {
            fs.copyFileSync(walPath, backupPath + '-wal');
        }
        if (fs.existsSync(shmPath)) {
            fs.copyFileSync(shmPath, backupPath + '-shm');
        }

        const stats = fs.statSync(backupPath);
        const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

        console.log(`✅ Backup created: ${backupFileName} (${sizeMB} MB)`);

        // Clean old backups
        cleanOldBackups();

        return backupPath;
    } catch (err) {
        console.error('❌ Backup failed:', err.message);
        return null;
    }
}

function cleanOldBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('scanning_backup_') && f.endsWith('.db'))
            .map(f => ({
                name: f,
                path: path.join(BACKUP_DIR, f),
                time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time); // Newest first

        // Remove old backups beyond MAX_BACKUPS
        if (files.length > MAX_BACKUPS) {
            const toDelete = files.slice(MAX_BACKUPS);
            toDelete.forEach(file => {
                fs.unlinkSync(file.path);
                // Also delete associated WAL/SHM files
                if (fs.existsSync(file.path + '-wal')) fs.unlinkSync(file.path + '-wal');
                if (fs.existsSync(file.path + '-shm')) fs.unlinkSync(file.path + '-shm');
                console.log(`🗑️  Deleted old backup: ${file.name}`);
            });
        }
    } catch (err) {
        console.error('Warning: Could not clean old backups:', err.message);
    }
}

function listBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('scanning_backup_') && f.endsWith('.db'))
            .map(f => {
                const filePath = path.join(BACKUP_DIR, f);
                const stats = fs.statSync(filePath);
                return {
                    name: f,
                    size: (stats.size / (1024 * 1024)).toFixed(2) + ' MB',
                    date: stats.mtime.toLocaleString('en-IN')
                };
            })
            .sort((a, b) => b.name.localeCompare(a.name));

        console.log('\n📁 Available Backups:');
        console.log('─'.repeat(60));
        files.forEach((f, i) => {
            console.log(`${i + 1}. ${f.name} (${f.size}) - ${f.date}`);
        });
        console.log('─'.repeat(60));
        console.log(`Total: ${files.length} backups\n`);

        return files;
    } catch (err) {
        console.error('Error listing backups:', err.message);
        return [];
    }
}

function restoreBackup(backupName) {
    const backupPath = path.join(BACKUP_DIR, backupName);

    if (!fs.existsSync(backupPath)) {
        console.error('❌ Backup file not found:', backupName);
        return false;
    }

    try {
        // Create a backup of current DB before restore
        const preRestoreBackup = path.join(BACKUP_DIR, `pre_restore_${Date.now()}.db`);
        if (fs.existsSync(DB_PATH)) {
            fs.copyFileSync(DB_PATH, preRestoreBackup);
            console.log(`📦 Current DB backed up to: pre_restore_${Date.now()}.db`);
        }

        // Restore
        fs.copyFileSync(backupPath, DB_PATH);

        // Restore WAL/SHM if they exist
        if (fs.existsSync(backupPath + '-wal')) {
            fs.copyFileSync(backupPath + '-wal', DB_PATH + '-wal');
        }
        if (fs.existsSync(backupPath + '-shm')) {
            fs.copyFileSync(backupPath + '-shm', DB_PATH + '-shm');
        }

        console.log(`✅ Database restored from: ${backupName}`);
        console.log('⚠️  Please restart the server for changes to take effect.');
        return true;
    } catch (err) {
        console.error('❌ Restore failed:', err.message);
        return false;
    }
}

// CLI interface
const args = process.argv.slice(2);
const command = args[0];

switch (command) {
    case 'create':
        createBackup();
        break;
    case 'list':
        listBackups();
        break;
    case 'restore':
        if (!args[1]) {
            console.log('Usage: node backup.js restore <backup_filename>');
            console.log('Run "node backup.js list" to see available backups');
        } else {
            restoreBackup(args[1]);
        }
        break;
    default:
        console.log(`
📦 ScanTrack Backup Utility
═══════════════════════════

Commands:
  node backup.js create    - Create a new backup
  node backup.js list      - List all backups
  node backup.js restore <filename> - Restore from a backup

Examples:
  node backup.js create
  node backup.js restore scanning_backup_2026-02-19T10-30-00.db
`);
}

module.exports = { createBackup, listBackups, restoreBackup };
