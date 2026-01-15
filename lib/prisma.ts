/**
 * Database connection utility using Prisma Client
 * Implements singleton pattern for connection pooling
 *
 * Prisma 7 Configuration:
 * - Uses @prisma/adapter-pg for PostgreSQL driver adapter
 * - Runtime uses DATABASE_URL (pooled connection via PgBouncer)
 * - CLI uses DIRECT_URL from prisma.config.ts (for migrations)
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

// PrismaClient is attached to the `global` object in development to prevent
// exhausting your database connection limit.
// Learn more: https://pris.ly/d/help/next-js-best-practices

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: Pool | undefined;
};

// Create connection pool for PostgreSQL
const pool =
  globalForPrisma.pool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.pool = pool;

// Create Prisma adapter using the pool
const adapter = new PrismaPg(pool);

// Initialize Prisma Client with adapter
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
