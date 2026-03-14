const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '..', '.env');

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function upsert(lines, key, value) {
  const prefix = `${key}=`;
  const index = lines.findIndex((line) => line.startsWith(prefix));
  const next = `${key}=${value}`;

  if (index >= 0) {
    lines[index] = next;
  } else {
    lines.push(next);
  }
}

try {
  if (!fs.existsSync(envPath)) {
    throw new Error('backend/.env not found.');
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);

  upsert(lines, 'JWT_SECRET', randomHex(48));
  upsert(lines, 'IMAGE_ENCRYPTION_KEY', randomHex(32));
  upsert(lines, 'BACKUP_ENCRYPTION_KEY', randomHex(32));

  fs.writeFileSync(envPath, `${lines.join('\n').trim()}\n`, 'utf8');
  console.log('Secrets rotated in backend/.env: JWT_SECRET, IMAGE_ENCRYPTION_KEY, BACKUP_ENCRYPTION_KEY');
  console.log('Restart backend now so new secrets take effect.');
} catch (error) {
  console.error(`Secret rotation failed: ${error.message}`);
  process.exit(1);
}
