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

## Notes

- Local data is stored in `data/users.json`.
- For production, persistent storage is required. Do not rely on ephemeral filesystem storage in serverless environments.
