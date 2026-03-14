const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const OTPS_FILE = path.join(DATA_DIR, 'otps.json');
const GALLERY_FILE = path.join(DATA_DIR, 'gallery.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');

const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function ensureBackupKey() {
  if (!BACKUP_ENCRYPTION_KEY || !/^[a-fA-F0-9]{64}$/.test(BACKUP_ENCRYPTION_KEY)) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a 64-character hex string in backend/.env');
  }
}

function createBackup(reason) {
  ensureBackupKey();

  const backupKey = Buffer.from(BACKUP_ENCRYPTION_KEY, 'hex');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(BACKUPS_DIR, `backup-${stamp}`);
  const mediaBackupDir = path.join(backupDir, 'images');

  fs.mkdirSync(mediaBackupDir, { recursive: true });
  fs.cpSync(IMAGES_DIR, mediaBackupDir, { recursive: true });

  const payload = JSON.stringify(
    {
      version: 1,
      createdAt: new Date().toISOString(),
      reason,
      imagesRoot: IMAGES_DIR,
      users: readJson(USERS_FILE),
      otps: readJson(OTPS_FILE),
      gallery: readJson(GALLERY_FILE),
      folders: readJson(FOLDERS_FILE),
    },
    null,
    2
  );

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', backupKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  fs.writeFileSync(
    path.join(backupDir, 'metadata.enc.json'),
    JSON.stringify(
      {
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: encrypted.toString('base64'),
      },
      null,
      2
    )
  );

  return backupDir;
}

try {
  const reason = process.argv.slice(2).join(' ').trim() || 'manual';
  const backupPath = createBackup(reason);
  console.log(`Backup created: ${backupPath}`);
} catch (error) {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
}
