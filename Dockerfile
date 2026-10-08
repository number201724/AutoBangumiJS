# AutoBangumi (Node.js) — multi-stage image.
#
#   docker build --build-arg VERSION=3.3.6 -t autobangumi-node .
#   docker run -d -p 7892:7892 \
#     -v $(pwd)/config:/app/config -v $(pwd)/data:/app/data autobangumi-node

FROM node:22-alpine AS builder
# better-sqlite3 builds from source on musl (no prebuilt musl binaries)
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/types/package.json packages/types/
COPY apps/backend/package.json apps/backend/
COPY apps/webui/package.json apps/webui/
RUN pnpm install --frozen-lockfile

COPY packages/types packages/types
COPY apps/backend apps/backend
COPY apps/webui apps/webui

# Bake the release version into the backend (mirrors CI generating
# module/__version__.py); VERSION != DEV_VERSION enables production mode
# (config.json + static hosting of the built WebUI).
ARG VERSION=local
RUN sed -i "s/export const VERSION: string = '.*';/export const VERSION: string = '${VERSION}';/" \
      apps/backend/src/version.ts \
    && pnpm -r build \
    && pnpm --filter @ab/backend deploy --prod /app/backend-prod

FROM node:22-alpine
RUN apk add --no-cache tini tzdata
WORKDIR /app

COPY --from=builder /app/backend-prod/node_modules ./node_modules
COPY --from=builder /app/apps/backend/dist ./dist-backend
COPY --from=builder /app/apps/webui/dist ./dist

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    AB_STATIC_DIR=/app/dist

EXPOSE 7892
VOLUME ["/app/config", "/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "let p=7892;try{p=require('/app/config/config.json').program.webui_port}catch(e){}fetch('http://127.0.0.1:'+p+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "-g", "--"]
CMD ["node", "dist-backend/main.js"]
