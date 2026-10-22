/**
 * @jest-environment node
 */

/**
 * The guard that asks whether a pull request's new schema objects exist in the
 * live database.
 *
 * The fixtures are VERBATIM output of
 * `prisma migrate diff --from-schema=<merge base> --to-schema=prisma/schema.prisma --script`,
 * not hand-written SQL: the first one is what the storefront-merchandising
 * branch actually produced, and the second is the mixed-direction shape Prisma
 * emits when a statement both drops and adds.
 */

import {
  describeObject,
  isPresent,
  requiredObjects,
  splitClauses,
  type LiveCatalog,
} from "@/scripts/ci/check-db-schema-required";

/** The plan the storefront-merchandising branch produced against its base. */
const MERCHANDISING_PLAN = `
-- AlterTable
ALTER TABLE "ConsultationPlan" ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SubscriptionPlan" ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WebinarPlan" ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ClassPlan" ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;
`;

/** One statement that both drops and adds — the shape a reconcile plan has. */
const MIXED_DIRECTION_PLAN = `
-- AlterTable
ALTER TABLE "ConsultationPlan" DROP COLUMN "recordingStoragePolicy", ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;
`;

describe("the plan reader", () => {
  it("reads the eight columns the storefront branch adds, and nothing else", () => {
    const required = requiredObjects(MERCHANDISING_PLAN);
    expect(required).toHaveLength(8);
    expect(required.map((r) => `${r.owner}.${r.name}`)).toEqual([
      "ConsultationPlan.isFeatured",
      "ConsultationPlan.sortOrder",
      "SubscriptionPlan.isFeatured",
      "SubscriptionPlan.sortOrder",
      "WebinarPlan.isFeatured",
      "WebinarPlan.sortOrder",
      "ClassPlan.isFeatured",
      "ClassPlan.sortOrder",
    ]);
    expect(new Set(required.map((r) => r.kind))).toEqual(new Set(["column"]));
  });

  it("prints the SQL that creates each missing object", () => {
    const required = requiredObjects(MERCHANDISING_PLAN);
    expect(required[0].ddl).toBe(
      'ALTER TABLE "ConsultationPlan" ADD COLUMN "isFeatured" BOOLEAN NOT NULL DEFAULT false;',
    );
    expect(required[1].ddl).toBe(
      'ALTER TABLE "ConsultationPlan" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;',
    );
  });

  it("reads the ADD COLUMN out of a statement that also drops one", () => {
    // The drop belongs to the reconcile push. Reading it here is what made the
    // previous live-database pull-request check block every schema change.
    const required = requiredObjects(MIXED_DIRECTION_PLAN);
    expect(required.map((r) => r.name)).toEqual(["isFeatured", "sortOrder"]);
    expect(required.every((r) => r.owner === "ConsultationPlan")).toBe(true);
    expect(required[0].ddl).not.toContain("recordingStoragePolicy");
  });

  it("reads a table, a type and an enum value", () => {
    const required = requiredObjects(`
-- CreateTable
CREATE TABLE "LedgerAccountBalance" ( "accountId" TEXT NOT NULL, CONSTRAINT "LedgerAccountBalance_pkey" PRIMARY KEY ("accountId") );

-- CreateType
CREATE TYPE "LedgerAccountKind_new" AS ENUM ('CASH', 'WALLET');

-- AlterType
ALTER TYPE "SupportCaseStatus" ADD VALUE 'ON_HOLD';
`);
    expect(required.map((r) => r.kind)).toEqual([
      "table",
      "enumType",
      "enumValue",
    ]);
    expect(required[2].owner).toBe("SupportCaseStatus");
    expect(required[2].name).toBe("ON_HOLD");
  });

  it("reads an empty plan as nothing to require", () => {
    expect(requiredObjects("-- This is an empty migration.")).toEqual([]);
  });

  it("ignores a plan that only drops things", () => {
    const required = requiredObjects(`
-- DropTable
DROP TABLE "SupportTicket";

-- AlterTable
ALTER TABLE "Recording" DROP COLUMN "storageUrl";

-- DropIndex
DROP INDEX "PlanMaterial_storagePath_key";
`);
    expect(required).toEqual([]);
  });
});

describe("clause splitting", () => {
  it("does not split on a comma inside a parenthesis", () => {
    // CREATE TABLE's column list is one value, not three.
    expect(
      splitClauses(
        'CREATE TABLE "X" ( "a" TEXT NOT NULL, "b" INTEGER NOT NULL, PRIMARY KEY ("a") )',
      ),
    ).toHaveLength(1);
  });

  it("does not split on a comma inside a quoted string", () => {
    expect(
      splitClauses(`ALTER TABLE "X" ADD COLUMN "y" TEXT DEFAULT 'a, b'`),
    ).toHaveLength(1);
  });

  it("splits a real clause list", () => {
    const clauses = splitClauses(
      'ALTER TABLE "X" ADD COLUMN "a" TEXT, ADD COLUMN "b" INTEGER',
    );
    expect(clauses).toHaveLength(2);
    expect(clauses[1]).toBe('ADD COLUMN "b" INTEGER');
  });
});

describe("the live catalog comparison", () => {
  const catalog: LiveCatalog = {
    tables: new Set(["ConsultationPlan"]),
    columns: new Set(["ConsultationPlan.isFeatured"]),
    enumTypes: new Set(["SupportCaseStatus"]),
    enumValues: new Set(["SupportCaseStatus.ON_HOLD"]),
  };

  it("finds a column that is there and misses one that is not", () => {
    const [isFeatured, sortOrder] = requiredObjects(MERCHANDISING_PLAN);
    expect(isPresent(isFeatured, catalog)).toBe(true);
    expect(isPresent(sortOrder, catalog)).toBe(false);
  });

  it("does not require the replacement type Prisma builds for a shrunken enum", () => {
    // The branch's code uses the ORIGINAL type, which the database already has.
    // The `_new` type is Prisma's own scaffolding.
    const [enumType] = requiredObjects(
      `-- CreateType\nCREATE TYPE "SupportCaseStatus_new" AS ENUM ('OPEN');`,
    );
    expect(enumType.name).toBe("SupportCaseStatus_new");
    expect(isPresent(enumType, catalog)).toBe(true);
  });

  it("finds an enum value and misses one that is not there", () => {
    const [value] = requiredObjects(
      `-- AlterType\nALTER TYPE "SupportCaseStatus" ADD VALUE 'ON_HOLD';`,
    );
    expect(isPresent(value, catalog)).toBe(true);
    expect(
      isPresent(
        {
          kind: "enumValue",
          owner: "SupportCaseStatus",
          name: "ON_HOLD_2",
          ddl: "",
        },
        catalog,
      ),
    ).toBe(false);
  });
});

describe("the report line", () => {
  it("names a column by its table and its column", () => {
    expect(
      describeObject({
        kind: "column",
        owner: "ConsultationPlan",
        name: "sortOrder",
        ddl: "",
      }),
    ).toBe("ConsultationPlan.sortOrder");
  });

  it("names an enum value as one", () => {
    expect(
      describeObject({
        kind: "enumValue",
        owner: "SupportCaseStatus",
        name: "ON_HOLD",
        ddl: "",
      }),
    ).toBe("SupportCaseStatus.ON_HOLD (enum value)");
  });
});
