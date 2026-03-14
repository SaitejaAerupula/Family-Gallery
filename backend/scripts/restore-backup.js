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

function ensureBackupKey() {
  if (!BACKUP_ENCRYPTION_KEY || !/^[a-fA-F0-9]{64}$/.test(BACKUP_ENCRYPTION_KEY)) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a 64-character hex string in backend/.env');
  }
}

function readEncryptedPayload(metadataPath) {
  ensureBackupKey();
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
  const backupKey = Buffer.from(BACKUP_ENCRYPTION_KEY, 'hex');
  const iv = Buffer.from(metadata.iv, 'hex');
  const tag = Buffer.from(metadata.tag, 'hex');
  const encrypted = Buffer.from(metadata.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', backupKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map((entry) => entry.name)
    .sort();
}

function resolveBackupDir(flag) {
  const backups = listBackups();
  if (!backups.length) {
    throw new Error('No backups found in backend/backups.');
  }

  if (!flag || flag === '--latest') {
    return path.join(BACKUPS_DIR, backups[backups.length - 1]);
  }

  return path.isAbsolute(flag) ? flag : path.join(BACKUPS_DIR, flag);
}

function restoreFromBackup(backupDir) {
  const metadataPath = path.join(backupDir, 'metadata.enc.json');
  const backupImagesDir = path.join(backupDir, 'images');

  if (!fs.existsSync(metadataPath)) {
    throw new Error(`metadata.enc.json not found in ${backupDir}`);
  }

  if (!fs.existsSync(backupImagesDir)) {
    throw new Error(`images directory not found in ${backupDir}`);
  }

  const payload = readEncryptedPayload(metadataPath);
  const oldImagesRoot = payload.imagesRoot;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.rmSync(IMAGES_DIR, { recursive: true, force: true });
  fs.cpSync(backupImagesDir, IMAGES_DIR, { recursive: true });

  const gallery = (payload.gallery || []).map((item) => {
    const rel = path.relative(oldImagesRoot, item.encryptedPath);
    return {
      ...item,
      encryptedPath: path.join(IMAGES_DIR, rel),
    };
  });

  fs.writeFileSync(USERS_FILE, JSON.stringify(payload.users || [], null, 2));
  fs.writeFileSync(OTPS_FILE, JSON.stringify(payload.otps || [], null, 2));
  fs.writeFileSync(GALLERY_FILE, JSON.stringify(gallery, null, 2));
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(payload.folders || [], null, 2));
}

try {
  const arg = process.argv[2] || '--latest';
  const backupDir = resolveBackupDir(arg);
  restoreFromBackup(backupDir);
  console.log(`Restore completed from: ${backupDir}`);
} catch (error) {
  console.error(`Restore failed: ${error.message}`);
  process.exit(1);
}
