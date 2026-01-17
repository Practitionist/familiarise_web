import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// IMPORTANT: Use DIRECT_URL (port 5432) to bypass PgBouncer pooler
// Using DATABASE_URL (port 6543) with Supabase causes "MaxClientsInSessionMode" errors
// because PgBouncer's session mode has very limited connections (3-10)
const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!process.env.DIRECT_URL && process.env.NODE_ENV === "development") {
  console.warn(
    "⚠️  DIRECT_URL not set - using DATABASE_URL which may cause connection pool exhaustion.\n" +
    "   Set DIRECT_URL in your .env file with port 5432 (not 6543) to fix this."
  );
}

const adapter = new PrismaPg({
  connectionString,
  max: 20, // Maximum connections in the pool (prevents pool exhaustion)
});

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

export default prisma;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
