# HYFCeph Portal

HYFCeph Portal provides:

- user registration and login
- API key generation and validation
- admin management for API key expiry and deletion
- Bark push notifications for new registrations and ceph image submissions
- image-upload ceph measurement through a server-side SmartCheck session
- owner-side Chrome extension session sync as a fallback path
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

For public use, deploy the portal from GitHub to Vercel or to any persistent Node runtime.

This project is suitable for:

- Vercel deployment backed by Blob or Feishu Bitable storage
- `Node` project deployment on a Linux server
- `Docker` deployment with the bundled `Dockerfile`

The default public image path now works like this:

1. Public user uploads a ceph image with their API key.
2. The portal first uses the server-side SmartCheck session token.
3. If the server-side session is unavailable, the portal can fall back to the Chrome extension synced session.
4. The server calls SmartCheck and returns PNG plus metrics.

Because of that, public users do not install a plugin and do not provide share links or upstream tokens. The Chrome extension is still kept as a backup operator path.

## Node deployment

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
- `HYFCEPH_SMARTCHECK_SESSION_MODE` (`server-first`, `extension-first`, `server-only`, or `extension-only`)
- `HYFCEPH_SMARTCHECK_TOKEN`
- `HYFCEPH_SMARTCHECK_PAGE_URL`
- `HYFCEPH_SMARTCHECK_SOURCE`
- `HYFCEPH_SMARTCHECK_API_HOST`
- `HYFCEPH_SMARTCHECK_OSS_HOST`
- `HYFCEPH_SMARTCHECK_REGION_ID`
- `HYFCEPH_FEISHU_APP_ID`
- `HYFCEPH_FEISHU_APP_SECRET`
- `HYFCEPH_FEISHU_BITABLE_APP_TOKEN`
- `HYFCEPH_FEISHU_BITABLE_TABLE_ID`
- `HYFCEPH_FEISHU_STORE_KEY`

SmartCheck server-first mode:

```bash
HYFCEPH_SMARTCHECK_SESSION_MODE=server-first
HYFCEPH_SMARTCHECK_TOKEN=your_smartcheck_token
```

`HYFCEPH_SMARTCHECK_SESSION_MODE=server-first` is the default. If the server token is missing or rejected, an active Chrome extension synced session remains the backup. Use `server-only` only when you deliberately want to disable that fallback.

## Notes

- Local data is stored in `data/users.json`.
- The owner-side Chrome extension lives in `chrome-extension/` and remains available as the fallback session bridge.
- The extension should be configured with the portal URL and an active admin API key.
- For Vercel, connect a private Blob store and set `HYFCEPH_STORE_BACKEND=blob`.
- When using Vercel, authentication uses signed cookies instead of in-memory sessions.
- Public production use should still prefer self-hosted deployment, because the image measurement path shells out to the bundled Node runner.

## Feishu Bitable storage

If you want to avoid Vercel Blob limits, you can switch the account store to Feishu Bitable.

Required environment variables:

```bash
HYFCEPH_STORE_BACKEND=feishu-bitable
HYFCEPH_FEISHU_APP_ID=your_feishu_app_id
HYFCEPH_FEISHU_APP_SECRET=your_feishu_app_secret
HYFCEPH_FEISHU_BITABLE_APP_TOKEN=your_bitable_app_token
HYFCEPH_FEISHU_BITABLE_TABLE_ID=your_bitable_table_id
```

The portal stores the full HYFCeph JSON state in one Bitable record keyed by `hyfceph-store`.

## Recovering old Blob data into Feishu

When Blob access becomes available again, you can export or migrate the old store directly.

Preview a migration from Blob to Feishu:

```bash
HYFCEPH_STORE_BLOB_PATH=hyfceph/users.json \
BLOB_READ_WRITE_TOKEN=your_blob_token \
HYFCEPH_FEISHU_APP_ID=your_feishu_app_id \
HYFCEPH_FEISHU_APP_SECRET=your_feishu_app_secret \
HYFCEPH_FEISHU_BITABLE_APP_TOKEN=your_bitable_app_token \
HYFCEPH_FEISHU_BITABLE_TABLE_ID=your_bitable_table_id \
npm run store:migrate -- --from blob --to feishu-bitable --mode merge --dry-run
```

Apply the migration:

```bash
HYFCEPH_STORE_BLOB_PATH=hyfceph/users.json \
BLOB_READ_WRITE_TOKEN=your_blob_token \
HYFCEPH_FEISHU_APP_ID=your_feishu_app_id \
HYFCEPH_FEISHU_APP_SECRET=your_feishu_app_secret \
HYFCEPH_FEISHU_BITABLE_APP_TOKEN=your_bitable_app_token \
HYFCEPH_FEISHU_BITABLE_TABLE_ID=your_bitable_table_id \
npm run store:migrate -- --from blob --to feishu-bitable --mode merge
```

If you manage to export a historical JSON file first, you can also import it:

```bash
HYFCEPH_FEISHU_APP_ID=your_feishu_app_id \
HYFCEPH_FEISHU_APP_SECRET=your_feishu_app_secret \
HYFCEPH_FEISHU_BITABLE_APP_TOKEN=your_bitable_app_token \
HYFCEPH_FEISHU_BITABLE_TABLE_ID=your_bitable_table_id \
npm run store:migrate -- --from file --file ./old-users.json --to feishu-bitable --mode merge
```

## WeChat bot worker

Run the WeChat Clawbot bridge as a persistent Node worker. In server-first mode the bot sends images to the portal, and the portal uses the server-side SmartCheck session first; the direct runner remains a fallback.

For a cloud or server worker:

```bash
HYFCEPH_API_KEY='your-admin-api-key' \
HYFCEPH_WEIXIN_PORTAL_BASE_URL='https://your-vercel-domain.vercel.app' \
HYFCEPH_WEIXIN_MEASURE_MODE='portal-first' \
npm run weixin:bot
```

Vercel functions are not suitable for keeping the bot long-poll process alive. Keep the portal on Vercel, then run this worker on a persistent Node host.

Manual foreground run for a Mac fallback:

```bash
HYFCEPH_API_KEY='your-admin-api-key' \
HYFCEPH_WEIXIN_PORTAL_BASE_URL='https://hyfceph.52ortho.com' \
HYFCEPH_WEIXIN_MEASURE_MODE='portal-first' \
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
