# Bruno Web: the Bruno API client in the browser.
# Build:  docker build -t bruno-web .
# Run:    docker run -p 8484:8484 -v bruno-data:/data -e BRUNO_WEB_PASSWORD=... bruno-web

FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json UPSTREAM_COMMIT ./
COPY scripts ./scripts
COPY patches ./patches
RUN npm ci --omit=dev --no-audit --no-fund
RUN scripts/fetch-upstream.sh /app/upstream \
  && rm -rf /app/upstream/.git /app/upstream/tests /app/upstream/packages/bruno-app/node_modules/.cache
COPY server ./server
COPY web ./web
# extract-channels wrote web/channels.json into the build context copy above;
# regenerate it against the fetched upstream.
RUN BRUNO_WEB_UPSTREAM=/app/upstream node scripts/extract-channels.js

FROM node:22-bookworm-slim
# git: upstream's Git features shell out to it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=1000:1000 /app /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8484 \
    BRUNO_WEB_DATA=/data
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
VOLUME /data
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8484)+'/bruno-web/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--require", "./server/install-shim.js", "server/index.js"]
