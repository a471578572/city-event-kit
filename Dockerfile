FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    BASE_PATH=/event \
    PUBLIC_ORIGIN=http://127.0.0.1:3000

# The local runtime uses only Node.js built-in modules.
COPY --chown=node:node package.json ./
COPY --chown=node:node cloud/ ./cloud/
COPY --chown=node:node web/ ./web/
COPY --chown=node:node licenses/ ./licenses/
COPY --chown=node:node LICENSE NOTICE ./

RUN mkdir -p /app/data && chown node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:" + process.env.PORT + process.env.BASE_PATH + "/api/health").then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));'

CMD ["node", "cloud/local.mjs"]
