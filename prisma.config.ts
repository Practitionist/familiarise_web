/**
 * Prisma 7 Configuration
 *
 * Defines database connection, schema location, and migration settings.
 * In Prisma 7, datasource URLs are configured here instead of in schema.prisma
 *
 * @see https://www.prisma.io/docs/orm/reference/prisma-config-reference
 */

import "dotenv/config";
import { defineConfig } from "prisma/config";

// Use DIRECT_URL if available, otherwise fallback to a placeholder for CI
// The placeholder allows `prisma generate` to work in CI environments
// where no actual database connection is needed
const databaseUrl =
  process.env.DIRECT_URL ||
  "postgresql://placeholder:placeholder@localhost:5432/placeholder";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "npx tsx prisma/seed.ts",
  },
  datasource: {
    // For Prisma CLI (migrations, introspection) - use direct connection
    url: databaseUrl,
  },
});
