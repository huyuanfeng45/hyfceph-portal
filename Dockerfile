FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    HYFCEPH_HOST=0.0.0.0 \
    HYFCEPH_PORT=3077 \
    CEPH_AUTOPOINT_BOOTSTRAP_PYTHON=/usr/bin/python3

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3077

CMD ["npm", "run", "start"]
