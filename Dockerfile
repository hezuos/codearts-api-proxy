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
ENV ENCRYPTION_KEY
ENV NODE_ENV=production

# The readiness endpoint also verifies writable persistent storage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:1455/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
