# ─── Stage 1: Install dependencies ────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Copy package files and install. The build needs the developer tools too, and
# some of them (ESLint 8 and the loader drizzle-kit uses) print npm deprecation
# warnings until they are upgraded, so npm's warnings are not shown here.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --loglevel=error

# ─── Stage 2: Build the application ──────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependencies from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Build Next.js (standalone output), without sending Next.js usage statistics
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── Stage 3: Production image ───────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Create non-root user for security
RUN addgroup --system --gid 1001 ccc && \
    adduser --system --uid 1001 ccc

# Copy the standalone build output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Copy public assets if they exist (optional — app may not have a public/ dir)
# Using a wildcard so the build doesn't fail if the directory is absent
COPY --from=builder /app/public* ./public/

# Copy database migrations (needed at runtime for auto-migration): getClient()
# runs the drizzle-kit migrator over lib/db/migrations-pg (+ the audit-
# immutability triggers in migrations-pg-audit) at first open, so both must be
# present in the runtime image or the hub fails to boot.
COPY --from=builder /app/lib/db/migrations-pg ./lib/db/migrations-pg
COPY --from=builder /app/lib/db/migrations-pg-audit ./lib/db/migrations-pg-audit

# Copy utility scripts (seeders, admin tools)
COPY --from=builder /app/scripts ./scripts

# Copy other runtime dependencies not bundled by Next.js standalone
COPY --from=deps /app/node_modules/@anthropic-ai ./node_modules/@anthropic-ai
COPY --from=deps /app/node_modules/@aws-sdk ./node_modules/@aws-sdk
COPY --from=deps /app/node_modules/archiver ./node_modules/archiver
COPY --from=deps /app/node_modules/uuid ./node_modules/uuid

USER ccc

# Expose the default port
EXPOSE 3000

# Health check — uses the /api/health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# Default environment
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

CMD ["sh", "-c", "node scripts/wait-for-db.mjs && node server.js"]
