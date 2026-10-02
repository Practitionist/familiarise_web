/**
 * CI guard — prisma/schema.prisma must hold every table and column
 * BetterAuth writes for the app's real configuration (core + plugins +
 * additionalFields).
 *
 * BetterAuth 1.7 runs the same comparison against the generated Prisma
 * client on the first auth request and, on a mismatch, fails every
 * /api/auth/* call. This moves that failure to CI. It reuses BetterAuth's own
 * `getExpectedSchema` + `diffSchema`, so the rules (missing table, missing
 * column, a required column BetterAuth never writes) are exactly the
 * runtime's, and adds a type check the runtime does not do.
 *
 * Importing lib/auth.ts needs no database or secrets: the Prisma client and
 * BetterAuth only connect on first query.
 */
import { Prisma } from "@prisma/client";
import {
  diffSchema,
  formatSchemaFinding,
  getExpectedSchema,
} from "@better-auth/core/db/internal";

import { auth } from "../../lib/auth";

// The Prisma adapter addresses `model Account` as `account`.
const clientProperty = (model: string) =>
  model.charAt(0).toLowerCase() + model.slice(1);

const models = Prisma.dmmf.datamodel.models;
const actual = models.map((model) => ({
  name: clientProperty(model.name),
  columns: model.fields
    .filter((f) => f.kind !== "object")
    .map((f) => ({
      name: f.name,
      nullable: !f.isRequired,
      hasDefault: f.hasDefaultValue || f.isUpdatedAt === true,
    })),
}));

const expected = getExpectedSchema(auth.options);
const problems = diffSchema(expected, actual).map((f) =>
  formatSchemaFinding(f, "prisma"),
);

// BetterAuth field type -> Prisma scalar types that can hold it. A `string`
// may also be a Prisma enum (User.role is UserRole).
const COMPATIBLE: Record<string, string[]> = {
  string: ["String"],
  boolean: ["Boolean"],
  number: ["Int", "BigInt", "Float", "Decimal"],
  date: ["DateTime"],
};
for (const [table, { fields }] of Object.entries(expected)) {
  const model = models.find((m) => clientProperty(m.name) === table);
  for (const [column, attr] of Object.entries(fields)) {
    const field = model?.fields.find((f) => f.name === column);
    const want = typeof attr.type === "string" ? attr.type : null;
    if (!field || !want || !COMPATIBLE[want]) continue;
    const ok =
      COMPATIBLE[want].includes(field.type) ||
      (want === "string" && field.kind === "enum");
    if (!ok) {
      problems.push(
        `Column "${column}" on "${table}" is ${field.type}; BetterAuth writes a ${want}.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(
    `check-auth-schema: prisma/schema.prisma does not match what BetterAuth writes:\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
  process.exit(1);
}
console.log(
  `check-auth-schema: ok (${Object.keys(expected).length} BetterAuth tables match prisma/schema.prisma)`,
);
process.exit(0);
