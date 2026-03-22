# HYFCeph Portal

HYFCeph Portal provides:

- user registration and login
- API key generation and validation
- admin management for API key expiry and deletion
- Bark push notifications for new registrations and ceph image submissions
- image-upload ceph measurement through the bundled local ceph engine
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

- `Node` project deployment on a Linux server with Python 3 available
- `Docker` deployment with the bundled `Dockerfile`

This project is not suitable for Vercel image inference, because image mode depends on a local ceph engine runtime.

## Image engine

The bundled image engine lives inside this project:

```text
engines/ceph-autopoint/
```

Notes:

- The first image measurement will create `engines/ceph-autopoint/.venv/`
- The first image measurement will also download the ceph model into `engines/ceph-autopoint/models/hrnet-ceph19/best_model.pth`
- The model file is about 347 MB, so the first run is slower
- The server must be able to reach Hugging Face on first run, unless you pre-seed the model file yourself

## 1Panel / Node deployment

Use these basics:

- Runtime: Node.js 18 or newer
- Start command: `npm run start`
- Port: `3077`
- Persistent directories:
  - `data/`
  - `engines/ceph-autopoint/.venv/`
  - `engines/ceph-autopoint/models/`

The first request to image measurement will install Python dependencies inside the engine virtualenv and download the model if missing.

Your server also needs:

- `python3`
- `python3-venv`
- outbound network access for the first model download

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
  -v $(pwd)/engine-venv:/app/engines/ceph-autopoint/.venv \
  -v $(pwd)/engine-models:/app/engines/ceph-autopoint/models \
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
- `HYFCEPH_SESSION_SECRET`
- `HYFCEPH_STORE_BACKEND`
- `HYFCEPH_STORE_BLOB_PATH`
- `HYFCEPH_LOCAL_IMAGE_RUNNER`
- `CEPH_AUTOPOINT_BOOTSTRAP_PYTHON`
- `CEPH_AUTOPOINT_MODEL_DIR`
- `CEPH_AUTOPOINT_MODEL_URL`

## Notes

- Local data is stored in `data/users.json`.
- For Vercel, connect a private Blob store and set `HYFCEPH_STORE_BACKEND=blob`.
- When using Vercel, authentication uses signed cookies instead of in-memory sessions.
- Public production use should prefer self-hosted deployment if image upload measurement is required.
