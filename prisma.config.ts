/**
 * Prisma 7 Configuration
 *
 * Defines database connection, schema location, and migration settings.
 * In Prisma 7, datasource URLs are configured here instead of in schema.prisma
 *
 * @see https://www.prisma.io/docs/orm/reference/prisma-config-reference
 */

import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // For Prisma CLI (migrations, introspection) - use direct connection
    url: env("DIRECT_URL"),
  },
});
