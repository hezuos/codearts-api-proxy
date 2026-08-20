# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-alpine AS builder

# Enable pnpm via corepack with a reproducible version
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

WORKDIR /app

# Install all dependencies (for build)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
COPY public/ public/
RUN pnpm build

# ── Stage 2: Production deps ───────────────────────────────────
FROM node:22-alpine AS prod-deps

RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Stage 3: Runtime ───────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Copy production artifacts
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/public/ public/
COPY --from=prod-deps /app/node_modules/ node_modules/
COPY --from=builder /app/package.json package.json

# Create data directory for runtime state (should be mounted as volume)
RUN mkdir -p /app/data && chown node:node /app/data

# Persist encrypted accounts, sessions, and runtime metadata
VOLUME ["/app/data"]

# Run as non-root user (node user exists in node:*-alpine images)
USER node

EXPOSE 1455

# 运行时默认配置；敏感值（ENCRYPTION_KEY、DEFAULT_API_KEY、ADMIN_PASSWORD）通过部署环境注入。
ENV NODE_ENV=production \
    PORT=1455 \
    CALLBACK_PORT=1455 \
    DATA_DIR=/app/data \
    REQUEST_BODY_LIMIT=10mb \
    ENABLE_REFRESH_TASK=true \
    IS_MASTER_NODE=true \
    LOG_LEVEL=info \
    MODEL_CACHE_TTL=300 \
    UPSTREAM_TIMEOUT_MS=120000 \
    RATE_LIMIT_CHAT_MAX=60 \
    RATE_LIMIT_MODELS_MAX=120 \
    FULL_CONTEXT_INJECTION_ENABLED=true \
    FULL_CONTEXT_MAX_CHARS=1024000 \
    FULL_CONTEXT_MAX_CHARS_BY_MODEL={} \
    CHAIN_DIVERGENCE_REPAIR_ENABLED=true \
    MISSING_CONTEXT_HINT=""

# ENCRYPTION_KEY 必须通过 docker run -e 或 Compose secrets 注入，生产环境不可留空。
ENV ENCRYPTION_KEY

# The readiness endpoint also verifies writable persistent storage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:1455/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
