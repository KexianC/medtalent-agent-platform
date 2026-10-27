FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node nas-sync-worker ./nas-sync-worker
RUN mkdir -p /state && chown node:node /state

ENV NODE_ENV=production \
    NAS_TO_S3_SOURCE_ROOT=/nas/knowledge \
    NAS_TO_S3_STATE_DIR=/state \
    NAS_TO_S3_HEALTH_HOST=127.0.0.1 \
    NAS_TO_S3_HEALTH_PORT=8790

USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8790/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "nas-sync-worker/index.mjs"]
