# HYFCeph Portal

HYFCeph Portal provides:

- user registration and login
- API key generation and validation
- admin management for API key expiry and deletion
- Bark push notifications for new registrations and ceph image submissions
- image-upload ceph measurement through a shared remote browser session
- owner-side Chrome extension for syncing the remote browser session
- current-case bridge measurement as a compatibility path

## Local run

```bash
npm install
npm run start
```

Default URL:

```text
http://127.0.0.1:3077
```

## Recommended deployment

For public use, deploy this project on your own server or 1Panel host.

This project is suitable for:

- `Node` project deployment on a Linux server
- `Docker` deployment with the bundled `Dockerfile`

The default public image path now works like this:

1. Public user uploads a ceph image with their API key.
2. The portal reuses the owner's Chrome-synced remote session.
3. The server calls the upstream remote ceph service and returns PNG plus metrics.

Because of that, public users do not install a plugin and do not provide share links or upstream tokens.

## 1Panel / Node deployment

Use these basics:

- Runtime: Node.js 18 or newer
- Start command: `npm run start`
- Port: `3077`
- Persistent directories:
  - `data/`

## Docker deployment

Build:

```bash
docker build -t hyfceph-portal .
```

Run:

```bash
docker run -d \
  --name hyfceph-portal \
  -p 3077:3077 \
  -e HYFCEPH_SESSION_SECRET='replace-with-random-secret' \
  -e HYFCEPH_BARK_KEY='7ffBf7F85e3WbFyKrJTEcH' \
  -v $(pwd)/data:/app/data \
  hyfceph-portal
```

## Environment variables

- `HYFCEPH_HOST`
- `HYFCEPH_PORT`
- `HYFCEPH_ADMIN_USERNAME`
- `HYFCEPH_ADMIN_PASSWORD`
- `HYFCEPH_BARK_KEY`
- `HYFCEPH_BARK_BASE_URL`
- `HYFCEPH_API_KEY_DAYS`
- `HYFCEPH_OPERATOR_SESSION_TTL_MINUTES`
- `HYFCEPH_SESSION_SECRET`
- `HYFCEPH_STORE_BACKEND`
- `HYFCEPH_STORE_BLOB_PATH`

## Notes

- Local data is stored in `data/users.json`.
- The owner-side Chrome extension lives in `chrome-extension/`.
- The extension should be configured with the portal URL and an active admin API key.
- For Vercel, connect a private Blob store and set `HYFCEPH_STORE_BACKEND=blob`.
- When using Vercel, authentication uses signed cookies instead of in-memory sessions.
- Public production use should still prefer self-hosted deployment, because the image measurement path shells out to the bundled Node runner.

## WeChat bot on a local Mac

If you want the WeChat Clawbot bridge to keep running on your own Mac, use the bundled `launchd` installer.

Manual foreground run:

```bash
HYFCEPH_API_KEY='your-admin-api-key' \
HYFCEPH_WEIXIN_PORTAL_BASE_URL='https://hyfceph.52ortho.com' \
npm run weixin:bot
```

You can also use `HYFCEPH_WEIXIN_BOT_SECRET` instead of `HYFCEPH_API_KEY`. For most setups, using the admin API key is simpler.

Install as a macOS LaunchAgent:

```bash
HYFCEPH_API_KEY='your-admin-api-key' \
npm run weixin:bot:install:launchd -- --portal-base-url https://hyfceph.52ortho.com
```

Check status:

```bash
npm run weixin:bot:status
```

Remove LaunchAgent:

```bash
npm run weixin:bot:uninstall:launchd
```

The installer writes:

- config: `~/Library/Application Support/HYFCeph/weixin-bot.json`
- launch agent: `~/Library/LaunchAgents/com.hyf.hyfceph.weixin-bot.plist`
- logs: `~/Library/Logs/HYFCeph/weixin-bot.out.log` and `~/Library/Logs/HYFCeph/weixin-bot.err.log`
