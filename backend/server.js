const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;
const IMAGE_ENCRYPTION_KEY = process.env.IMAGE_ENCRYPTION_KEY;
const LEGACY_IMAGE_ENCRYPTION_KEYS = String(process.env.LEGACY_IMAGE_ENCRYPTION_KEYS || '');
const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY;
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'fg_session';
const COOKIE_SAME_SITE = process.env.COOKIE_SAME_SITE || 'Lax';
const FORCE_SECURE_COOKIE = process.env.FORCE_SECURE_COOKIE === 'true';
const AUTO_BACKUP_INTERVAL_MINUTES = Number(process.env.BACKUP_INTERVAL_MINUTES || 0);

if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET in environment.');
}

if (!IMAGE_ENCRYPTION_KEY || !/^[a-fA-F0-9]{64}$/.test(IMAGE_ENCRYPTION_KEY)) {
  throw new Error('IMAGE_ENCRYPTION_KEY must be a 64-character hex string.');
}

const encryptionKey = Buffer.from(IMAGE_ENCRYPTION_KEY, 'hex');
const legacyEncryptionKeys = LEGACY_IMAGE_ENCRYPTION_KEYS.split(',')
  .map((value) => value.trim())
  .filter(Boolean);

for (const key of legacyEncryptionKeys) {
  if (!/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error('LEGACY_IMAGE_ENCRYPTION_KEYS must contain comma-separated 64-character hex keys.');
  }
}

const decryptionKeys = [encryptionKey, ...legacyEncryptionKeys.map((key) => Buffer.from(key, 'hex'))];

const DATA_DIR = path.join(__dirname, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const FRONTEND_BUILD_DIR = path.join(__dirname, '..', 'build');
const shouldServeFrontend = process.env.SERVE_FRONTEND !== 'false' && fs.existsSync(FRONTEND_BUILD_DIR);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const OTPS_FILE = path.join(DATA_DIR, 'otps.json');
const GALLERY_FILE = path.join(DATA_DIR, 'gallery.json');
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');

for (const dir of [DATA_DIR, IMAGES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.mkdirSync(BACKUPS_DIR, { recursive: true });

for (const file of [USERS_FILE, OTPS_FILE, GALLERY_FILE, FOLDERS_FILE]) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '[]\n', 'utf-8');
  }
}

const MEDIA_TYPE_PREFIXES = {
  image: 'image/',
  video: 'video/',
  audio: 'audio/',
};

const ALLOWED_EXTENSIONS = {
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  video: ['.mp4', '.mov', '.m4v', '.webm'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac'],
};

const MAX_FILE_SIZE_BY_TYPE = {
  image: 12 * 1024 * 1024,
  video: 120 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
};

function normalizeMediaType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return MEDIA_TYPE_PREFIXES[normalized] ? normalized : '';
}

function normalizeFolderName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeFilename(name) {
  return String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '-')
    .trim();
}

function getFoldersByUser(email) {
  return readJson(FOLDERS_FILE).filter((folder) => folder.email === email);
}

function findFolderById(email, folderId) {
  return getFoldersByUser(email).find((folder) => folder.id === folderId) || null;
}

function toPublicMediaItem(item) {
  return {
    id: item.id,
    email: item.email,
    originalName: item.originalName,
    mimeType: item.mimeType,
    size: item.size,
    mediaType: item.mediaType || 'image',
    folderId: item.folderId || null,
    createdAt: item.createdAt,
  };
}

function listMediaByUser(email) {
  return readJson(GALLERY_FILE)
    .filter((item) => item.email === email)
    .map((item) => ({
      ...item,
      mediaType: item.mediaType || 'image',
      folderId: item.folderId || null,
    }));
}

function getMediaById(email, id) {
  return listMediaByUser(email).find((item) => item.id === id) || null;
}

function saveEncryptedMedia({ email, file, mediaType, folderId }) {
  const gallery = readJson(GALLERY_FILE);
  const userDir = getUserDirectory(email);
  const id = uuidv4();
  const encryptedFilePath = path.join(userDir, `${id}.enc`);
  const { iv, encrypted, tag } = encryptBuffer(file.buffer);

  fs.writeFileSync(encryptedFilePath, encrypted);

  const record = {
    id,
    email,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    mediaType,
    folderId: folderId || null,
    encryptedPath: encryptedFilePath,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    createdAt: new Date().toISOString(),
  };

  gallery.push(record);
  writeJson(GALLERY_FILE, gallery);

  return record;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  const source = String(cookieHeader || '');

  for (const part of source.split(';')) {
    const [rawKey, ...rest] = part.split('=');
    const key = String(rawKey || '').trim();
    if (!key) {
      continue;
    }
    const rawValue = rest.join('=').trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      cookies[key] = rawValue;
    }
  }

  return cookies;
}

function getRequestToken(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const fromCookie = String(cookies[AUTH_COOKIE_NAME] || '').trim();

  if (fromCookie) {
    return fromCookie;
  }

  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function shouldUseSecureCookie(req) {
  return FORCE_SECURE_COOKIE || process.env.NODE_ENV === 'production' || req.secure;
}

function setAuthCookie(req, res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(req),
    sameSite: COOKIE_SAME_SITE,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(req, res) {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: shouldUseSecureCookie(req),
    sameSite: COOKIE_SAME_SITE,
    path: '/',
  });
}

function detectBufferType(buffer) {
  if (!buffer || buffer.length < 12) {
    return '';
  }

  const hex4 = buffer.subarray(0, 4).toString('hex');
  const head = buffer.subarray(0, 12).toString('hex');
  const ascii = buffer.subarray(0, 12).toString('ascii');

  if (hex4 === 'ffd8ffe0' || hex4 === 'ffd8ffe1' || hex4 === 'ffd8ffe2' || hex4 === 'ffd8ffe3') {
    return 'image';
  }

  if (hex4 === '89504e47' || ascii.startsWith('GIF8')) {
    return 'image';
  }

  if (ascii.startsWith('RIFF') && head.includes('57454250')) {
    return 'image';
  }

  if (ascii.startsWith('ID3') || ascii.startsWith('OggS') || (ascii.startsWith('RIFF') && head.includes('57415645'))) {
    return 'audio';
  }

  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (['m4a ', 'isom', 'mp42', 'mp41', 'qt  '].includes(brand)) {
      return brand === 'm4a ' ? 'audio' : 'video';
    }
  }

  if (hex4 === '1a45dfa3') {
    return 'video';
  }

  return '';
}

function validateUploadFile(file, mediaType) {
  const errors = [];
  const cleanedName = normalizeFilename(file.originalname);
  const extension = path.extname(cleanedName).toLowerCase();
  const allowedExtensions = ALLOWED_EXTENSIONS[mediaType] || [];
  const maxSize = MAX_FILE_SIZE_BY_TYPE[mediaType] || 10 * 1024 * 1024;

  if (!file.mimetype.startsWith(MEDIA_TYPE_PREFIXES[mediaType])) {
    errors.push('MIME type does not match selected media type.');
  }

  if (!allowedExtensions.includes(extension)) {
    errors.push(`File extension ${extension || '(none)'} is not allowed for ${mediaType}.`);
  }

  if (file.size > maxSize) {
    errors.push(`File exceeds ${Math.round(maxSize / (1024 * 1024))}MB limit for ${mediaType}.`);
  }

  const detectedType = detectBufferType(file.buffer);
  if (!detectedType || detectedType !== mediaType) {
    errors.push('File signature check failed.');
  }

  return {
    valid: errors.length === 0,
    cleanedName,
    errors,
  };
}

function assertBackupKeyConfigured() {
  if (!BACKUP_ENCRYPTION_KEY || !/^[a-fA-F0-9]{64}$/.test(BACKUP_ENCRYPTION_KEY)) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be a 64-character hex string.');
  }
}

function createEncryptedBackup(reason = 'auto') {
  assertBackupKeyConfigured();

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getUserDirectory(email) {
  const hash = crypto.createHash('sha256').update(email).digest('hex');
  const dir = path.join(IMAGES_DIR, hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const smtpHost = String(process.env.SMTP_HOST || '').trim();
const smtpUser = String(process.env.SMTP_USER || '').trim();
const smtpPassRaw = String(process.env.SMTP_PASS || '').trim();
const isGmailSmtp = /(^|\.)gmail\.com$/i.test(smtpHost);

// Google app passwords are often copied with spaces in groups of 4.
const smtpPass = isGmailSmtp ? smtpPassRaw.replace(/\s+/g, '') : smtpPassRaw;

const mailer = nodemailer.createTransport({
  host: smtpHost,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: smtpUser,
    pass: smtpPass,
  },
});

function ensureSmtpConfigured() {
  const needed = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  for (const key of needed) {
    if (!String(process.env[key] || '').trim()) {
      throw new Error(`Missing ${key} in environment for email OTP.`);
    }
  }
}

function getSmtpTroubleshootingMessage(error) {
  const raw = `${error?.message || ''} ${error?.response || ''}`;
  const details = raw.toLowerCase();

  if (
    isGmailSmtp &&
    (details.includes('invalidsecondfactor') ||
      details.includes('application-specific password required') ||
      details.includes('5.7.9') ||
      Number(error?.responseCode) === 534)
  ) {
    return 'Gmail rejected SMTP login. Enable 2-Step Verification on the sender account, create a 16-character Google App Password, and set SMTP_PASS in backend/.env to that app password (not your normal Gmail password).';
  }

  return error?.message || 'Unknown SMTP error.';
}

function signToken(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: '7d' });
}

function authRequired(req, res, next) {
  const token = getRequestToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function encryptBuffer(input) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, encrypted, tag };
}

function decryptBuffer(encrypted, ivHex, tagHex) {
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  for (const key of decryptionKeys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    } catch {
      // Try next key in keyring.
    }
  }

  throw new Error('Unable to decrypt file with configured keys.');
}

app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

if (shouldServeFrontend) {
  app.use(express.static(FRONTEND_BUILD_DIR));
}

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Please try again later.' },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Please try again later.' },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many upload attempts. Please try again later.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 30,
  },
});

app.get('/', (req, res) => {
  if (shouldServeFrontend) {
    return res.sendFile(path.join(FRONTEND_BUILD_DIR, 'index.html'));
  }

  res.status(200).send(
    'Family Gallery API is running. Open http://localhost:3000 for the app UI, or use /api/health for API status.'
  );
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/request-otp', otpLimiter, async (req, res) => {
  try {
    ensureSmtpConfigured();

    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    const code = createOtpCode();
    const otpHash = await bcrypt.hash(code, 10);
    const now = Date.now();
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString();

    const otps = readJson(OTPS_FILE).filter((row) => row.email !== email);
    otps.push({
      email,
      otpHash,
      expiresAt,
      createdAt: new Date(now).toISOString(),
    });
    writeJson(OTPS_FILE, otps);

    const users = readJson(USERS_FILE);
    const existing = users.find((u) => u.email === email);
    if (!existing) {
      users.push({ email, createdAt: new Date().toISOString() });
      writeJson(USERS_FILE, users);
    }

    await mailer.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: 'Your Family Gallery OTP',
      text: `Your OTP is ${code}. It expires in 10 minutes.`,
      html: `<p>Your OTP is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`,
    });

    return res.json({ message: 'OTP sent successfully.' });
  } catch (error) {
    return res.status(500).json({
      error: 'Could not send OTP email. Check SMTP settings in your .env file.',
      details: getSmtpTroubleshootingMessage(error),
    });
  }
});

app.post('/api/auth/verify-otp', verifyLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const otp = String(req.body?.otp || '').trim();

  if (!isValidEmail(email) || !/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: 'Email and 6-digit OTP are required.' });
  }

  const otps = readJson(OTPS_FILE);
  const current = otps.find((o) => o.email === email);

  if (!current) {
    return res.status(400).json({ error: 'No OTP found. Request a new one.' });
  }

  if (new Date(current.expiresAt).getTime() < Date.now()) {
    writeJson(
      OTPS_FILE,
      otps.filter((o) => o.email !== email)
    );
    return res.status(400).json({ error: 'OTP expired. Request a new one.' });
  }

  const isMatch = await bcrypt.compare(otp, current.otpHash);
  if (!isMatch) {
    return res.status(400).json({ error: 'Invalid OTP.' });
  }

  writeJson(
    OTPS_FILE,
    otps.filter((o) => o.email !== email)
  );

  const token = signToken(email);
  setAuthCookie(req, res, token);
  return res.json({ email });
});

app.get('/api/auth/session', authRequired, (req, res) => {
  return res.json({ email: req.user.email });
});

app.get('/api/folders', authRequired, (req, res) => {
  const folders = getFoldersByUser(req.user.email).sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return res.json({ folders });
});

app.post('/api/folders', authRequired, (req, res) => {
  const name = normalizeFolderName(req.body?.name);

  if (!name || name.length < 2 || name.length > 60) {
    return res.status(400).json({ error: 'Folder name must be between 2 and 60 characters.' });
  }

  const folders = readJson(FOLDERS_FILE);
  const exists = folders.some(
    (folder) => folder.email === req.user.email && folder.name.toLowerCase() === name.toLowerCase()
  );

  if (exists) {
    return res.status(409).json({ error: 'A folder with this name already exists.' });
  }

  const folder = {
    id: uuidv4(),
    email: req.user.email,
    name,
    createdAt: new Date().toISOString(),
  };

  folders.push(folder);
  writeJson(FOLDERS_FILE, folders);

  return res.status(201).json({ message: 'Folder created.', folder });
});

app.get('/api/media', authRequired, (req, res) => {
  const mediaTypeFilter = req.query.type ? normalizeMediaType(req.query.type) : '';
  const folderIdFilter = String(req.query.folderId || '').trim();

  if (req.query.type && !mediaTypeFilter) {
    return res.status(400).json({ error: 'Invalid media type filter.' });
  }

  let media = listMediaByUser(req.user.email);

  if (mediaTypeFilter) {
    media = media.filter((item) => item.mediaType === mediaTypeFilter);
  }

  if (folderIdFilter) {
    media = media.filter((item) => item.folderId === folderIdFilter);
  }

  media.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return res.json({ media: media.map(toPublicMediaItem) });
});

app.post('/api/media/upload', authRequired, uploadLimiter, upload.array('files'), (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: 'Please choose at least one file.' });
  }

  const mediaType = normalizeMediaType(req.body?.mediaType);
  if (!mediaType) {
    return res.status(400).json({ error: 'mediaType must be image, video, or audio.' });
  }

  const folderId = String(req.body?.folderId || '').trim();
  if (folderId && !findFolderById(req.user.email, folderId)) {
    return res.status(400).json({ error: 'Selected folder does not exist.' });
  }

  const validated = files.map((file) => ({
    file,
    validation: validateUploadFile(file, mediaType),
  }));

  const invalid = validated.find((entry) => !entry.validation.valid);
  if (invalid) {
    return res.status(400).json({
      error: `Upload blocked for ${normalizeFilename(invalid.file.originalname) || 'file'}.`,
      details: invalid.validation.errors.join(' '),
    });
  }

  for (const entry of validated) {
    saveEncryptedMedia({
      email: req.user.email,
      file: {
        ...entry.file,
        originalname: entry.validation.cleanedName || entry.file.originalname,
      },
      mediaType,
      folderId: folderId || null,
    });
  }

  return res.json({ message: `Uploaded ${validated.length} ${mediaType}(s) successfully.` });
});

app.get('/api/media/:id', authRequired, (req, res) => {
  const item = getMediaById(req.user.email, req.params.id);

  if (!item) {
    return res.status(404).json({ error: 'Media not found.' });
  }

  if (!fs.existsSync(item.encryptedPath)) {
    return res.status(404).json({ error: 'Media file is missing.' });
  }

  let decrypted;
  try {
    const encryptedData = fs.readFileSync(item.encryptedPath);
    decrypted = decryptBuffer(encryptedData, item.iv, item.tag);
  } catch {
    return res.status(422).json({
      error: 'Media cannot be decrypted with current server keys.',
      details: 'If keys were rotated, add old keys to LEGACY_IMAGE_ENCRYPTION_KEYS in backend/.env.',
    });
  }

  res.setHeader('Content-Type', item.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(item.originalName)}"`);
  return res.send(decrypted);
});

app.get('/api/images', authRequired, (req, res) => {
  const gallery = listMediaByUser(req.user.email)
    .filter((item) => item.mediaType === 'image')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json({ images: gallery.map(toPublicMediaItem) });
});

app.post('/api/images/upload', authRequired, uploadLimiter, upload.array('images'), (req, res) => {
  const files = req.files || [];

  if (!files.length) {
    return res.status(400).json({ error: 'Please choose at least one image file.' });
  }

  const validated = files.map((file) => ({
    file,
    validation: validateUploadFile(file, 'image'),
  }));
  const invalid = validated.find((entry) => !entry.validation.valid);
  if (invalid) {
    return res.status(400).json({
      error: `Upload blocked for ${normalizeFilename(invalid.file.originalname) || 'file'}.`,
      details: invalid.validation.errors.join(' '),
    });
  }

  for (const entry of validated) {
    saveEncryptedMedia({
      email: req.user.email,
      file: {
        ...entry.file,
        originalname: entry.validation.cleanedName || entry.file.originalname,
      },
      mediaType: 'image',
      folderId: null,
    });
  }

  return res.json({ message: `Uploaded ${validated.length} image(s) successfully.` });
});

app.get('/api/images/:id', authRequired, (req, res) => {
  const item = getMediaById(req.user.email, req.params.id);

  if (!item || item.mediaType !== 'image') {
    return res.status(404).json({ error: 'Image not found.' });
  }

  if (!fs.existsSync(item.encryptedPath)) {
    return res.status(404).json({ error: 'Image file is missing.' });
  }

  let decrypted;
  try {
    const encryptedData = fs.readFileSync(item.encryptedPath);
    decrypted = decryptBuffer(encryptedData, item.iv, item.tag);
  } catch {
    return res.status(422).json({
      error: 'Image cannot be decrypted with current server keys.',
      details: 'If keys were rotated, add old keys to LEGACY_IMAGE_ENCRYPTION_KEYS in backend/.env.',
    });
  }

  res.setHeader('Content-Type', item.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(item.originalName)}"`);
  return res.send(decrypted);
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(req, res);
  return res.json({ message: 'Logged out successfully.' });
});

if (AUTO_BACKUP_INTERVAL_MINUTES > 0) {
  const backupEveryMs = AUTO_BACKUP_INTERVAL_MINUTES * 60 * 1000;
  let backupRunning = false;

  setInterval(() => {
    if (backupRunning) {
      return;
    }

    backupRunning = true;
    try {
      const backupPath = createEncryptedBackup('auto');
      console.log(`Auto backup created at ${backupPath}`);
    } catch (error) {
      console.error(`Auto backup failed: ${error.message}`);
    } finally {
      backupRunning = false;
    }
  }, backupEveryMs);
}

if (shouldServeFrontend) {
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      return next();
    }

    if (req.path.startsWith('/api')) {
      return next();
    }

    return res.sendFile(path.join(FRONTEND_BUILD_DIR, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`Secure gallery API listening on http://localhost:${PORT}`);
  if (shouldServeFrontend) {
    console.log(`Serving frontend build from ${FRONTEND_BUILD_DIR}`);
  }
});
