import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const adapter = new PrismaPg({
  // Use pooled connection (DATABASE_URL) for runtime queries to avoid connection exhaustion
  // DIRECT_URL is only for migrations (handled by prisma.config.ts)
  connectionString: process.env.DATABASE_URL || process.env.DIRECT_URL,
});

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["error", "warn"]
        : ["error"],
  });

export default prisma;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
