# Development Dockerfile for Familiarise
FROM node:22-alpine

# Install dependencies for native modules (bcrypt, sharp)
RUN apk add --no-cache libc6-compat python3 make g++

WORKDIR /app

# Copy package files. `.npmrc` MUST come along: it carries
# `legacy-peer-deps=true`, without which `npm ci` fails ERESOLVE on
# better-call's peerOptional zod@^4 against the project's zod@3.
COPY package.json package-lock.json .npmrc ./

# Prisma schema must land BEFORE `npm ci`: package.json has a `postinstall`
# of `prisma generate`, which fails with "Could not find Prisma Schema" if
# the schema arrives afterwards. That postinstall also makes a separate
# `npx prisma generate` step redundant.
COPY prisma ./prisma/

# Install dependencies (runs postinstall -> prisma generate)
RUN npm ci

# Copy application files (volumes will override in dev)
COPY . .

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start development server
CMD ["npm", "run", "dev"]
