# HYFCeph Portal

HYFCeph Portal provides:

- user registration and login
- API key generation and validation
- admin management for API key expiry and deletion
- Bark push notifications for new registrations and ceph image submissions

## Local run

```bash
npm install
npm run start
```

Default URL:

```text
http://127.0.0.1:3077
```

## Environment variables

- `HYFCEPH_HOST`
- `HYFCEPH_PORT`
- `HYFCEPH_ADMIN_USERNAME`
- `HYFCEPH_ADMIN_PASSWORD`
- `HYFCEPH_BARK_KEY`
- `HYFCEPH_BARK_BASE_URL`
- `HYFCEPH_API_KEY_DAYS`
- `HYFCEPH_SESSION_SECRET`
- `HYFCEPH_STORE_BACKEND`
- `HYFCEPH_STORE_BLOB_PATH`

## Notes

- Local data is stored in `data/users.json`.
- For Vercel, connect a private Blob store and set `HYFCEPH_STORE_BACKEND=blob`.
- When using Vercel, authentication uses signed cookies instead of in-memory sessions.
