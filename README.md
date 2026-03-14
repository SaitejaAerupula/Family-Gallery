# Family Gallery Vault

A secure personal media vault with:

- Email OTP login (real SMTP email delivery)
- Secure HTTP-only cookie sessions
- Server-side AES-256-GCM encrypted image/video/audio storage
- Folder-based media organization and private playback
- Encrypted backup + restore tooling

## Quick Start

1. Install packages:

```bash
npm install
```

2. Create environment file:

```bash
copy .env.example backend/.env
```

3. Edit `backend/.env` with your values:

- `JWT_SECRET`: long random secret
- `IMAGE_ENCRYPTION_KEY`: 64 hex chars (32 bytes)
- `LEGACY_IMAGE_ENCRYPTION_KEYS`: optional comma-separated old media keys for decrypting files uploaded before key rotation
- `BACKUP_ENCRYPTION_KEY`: different 64 hex chars for backup metadata encryption
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `AUTH_COOKIE_NAME`, `COOKIE_SAME_SITE`, `FORCE_SECURE_COOKIE`
- `BACKUP_INTERVAL_MINUTES` (0 disables auto backups)

For Gmail SMTP, `SMTP_PASS` must be a Google App Password (16 characters), not your normal Gmail password.

4. Start frontend + backend together:

```bash
npm start
```

Frontend: `http://localhost:3000`

Backend API: `http://localhost:5000/api`

## Scripts

- `npm start`: runs React app and Node backend together
- `npm run client`: runs only React app
- `npm run server`: runs only backend API
- `npm run build`: production build for frontend
- `npm run rotate:secrets`: rotates JWT/media/backup secrets inside `backend/.env`
- `npm run backup:create`: creates encrypted backup snapshot in `backend/backups`
- `npm run backup:restore -- --latest`: restores from latest backup
- `npm run backup:restore -- backup-YYYY-MM-DDTHH-MM-SS-sssZ`: restore specific backup folder

## Security Notes

- Images/videos/audio are encrypted before writing to disk.
- OTP values are hashed before storing.
- OTP expires after 10 minutes.
- Auth endpoints are rate-limited.
- Uploads include MIME + extension + signature validation.
- Login uses HTTP-only cookies to reduce token theft risk from client-side scripts.

## HTTPS And Deployment

For production:

- Use HTTPS only (Nginx/Caddy/Cloudflare tunnel/managed platform TLS).
- Set `FORCE_SECURE_COOKIE=true`.
- Prefer `COOKIE_SAME_SITE=Lax` for same-site frontend and API.
- Restrict firewall to only required ports.
- Keep OS and Node updated.
- Monitor logs and set backup retention policies.

## Host On Render (Quickest)

Use one Render Web Service so backend serves the frontend build.

1. In Render, create New + Web Service.
2. Connect repository: `SaitejaAerupula/Family-Gallery`.
3. Settings:
- Runtime: `Node`
- Build Command: `npm install && npm run build`
- Start Command: `npm run server`
- Branch: `main`
4. Add environment variables from `backend/.env`:
- `PORT=10000`
- `JWT_SECRET`, `IMAGE_ENCRYPTION_KEY`, `LEGACY_IMAGE_ENCRYPTION_KEYS`
- `BACKUP_ENCRYPTION_KEY`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `CORS_ORIGIN=https://<your-render-domain>`
- `AUTH_COOKIE_NAME=fg_session`
- `COOKIE_SAME_SITE=Lax`
- `FORCE_SECURE_COOKIE=true`
- `BACKUP_INTERVAL_MINUTES=0` (or your interval)
- `NODE_ENV=production`
5. Deploy.

After deploy, your app is available from one URL and APIs are at `/api/*` on the same domain.

Note about storage:

- This app stores encrypted files on local server disk (`backend/data`).
- On free/ephemeral platforms, files may be lost on restart/redeploy.
- For reliable hosting, use a persistent disk or migrate media storage to object storage.

## Backup Restore Test (Recommended)

1. Create a backup:

```bash
npm run backup:create
```

2. Restore latest backup into local environment:

```bash
npm run backup:restore -- --latest
```

3. Restart backend and verify media/folders are intact.

## Practical Advice

- Upload low-risk data first for testing.
- After you validate restore workflow, then upload irreplaceable private archives.
