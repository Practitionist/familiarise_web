import { Client } from "pg";
import { Prisma } from "@prisma/client";
import { assertDisposableDatabase } from "./guard";
import { refundableBalancePaise } from "../../lib/payments/refundable-balance";
import { refundableBalancePaiseSql } from "../../lib/payments/refundable-balance-sql";

let client: Client;

function physicalName(modelName: string, fieldName?: string): string {
  const model = Prisma.dmmf.datamodel.models.find(
    (item) => item.name === modelName,
  );
  if (!model) throw new Error(`Missing fixture model ${modelName}`);
  if (fieldName === undefined) return `"${model.dbName ?? model.name}"`;
  const field = model.fields.find((item) => item.name === fieldName);
  if (!field)
    throw new Error(`Missing fixture field ${modelName}.${fieldName}`);
  return `"${field.dbName ?? field.name}"`;
}

beforeAll(async () => {
  assertDisposableDatabase();
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const fixtures: Record<string, Record<string, string>> = {
    Payment: {
      id: "text PRIMARY KEY",
      amount: "bigint",
    },
    Refund: {
      paymentId: "text",
      amountPaise: "bigint",
      status: "text",
    },
    Dispute: {
      paymentId: "text",
      amountPaise: "bigint",
      status: "text",
    },
  };
  await client.query(
    Object.entries(fixtures)
      .map(
        ([model, columns]) =>
          `CREATE TEMP TABLE ${physicalName(model)} (${Object.entries(columns)
            .map(([field, ddl]) => `${physicalName(model, field)} ${ddl}`)
            .join(", ")})`,
      )
      .join(";"),
  );
});

afterAll(async () => {
  await client?.end();
});

beforeEach(async () => {
  await client.query(
    `TRUNCATE ${["Payment", "Refund", "Dispute"]
      .map((model) => physicalName(model))
      .join(", ")}`,
  );
});

async function payment(id: string, amount: number) {
  await client.query(
    `INSERT INTO ${physicalName("Payment")} (${physicalName("Payment", "id")}, ${physicalName("Payment", "amount")}) VALUES ($1, $2)`,
    [id, amount],
  );
}

async function refund(id: string, amount: number, status: string) {
  await client.query(
    `INSERT INTO ${physicalName("Refund")} (${physicalName("Refund", "paymentId")}, ${physicalName("Refund", "amountPaise")}, ${physicalName("Refund", "status")}) VALUES ($1, $2, $3)`,
    [id, amount, status],
  );
}

async function dispute(id: string, amount: number, status: string) {
  await client.query(
    `INSERT INTO ${physicalName("Dispute")} (${physicalName("Dispute", "paymentId")}, ${physicalName("Dispute", "amountPaise")}, ${physicalName("Dispute", "status")}) VALUES ($1, $2, $3)`,
    [id, amount, status],
  );
}

it.each(["SUCCEEDED", "PENDING", "FAILED", "CANCELLED"])(
  "SQL balance agrees with centralized arithmetic for %s refunds and returned disputes",
  async (status) => {
    await payment("a", 10000);
    await refund("a", 2500, status);
    await dispute("a", 3000, "LOST");
    await dispute("a", 4000, "UNDER_REVIEW");

    const sql = Prisma.sql`SELECT ${refundableBalancePaiseSql(
      Prisma.sql`p.${Prisma.raw(physicalName("Payment", "id"))}`,
      Prisma.sql`p.${Prisma.raw(physicalName("Payment", "amount"))}`,
    )} AS balance FROM ${Prisma.raw(physicalName("Payment"))} p WHERE p.${Prisma.raw(physicalName("Payment", "id"))} = 'a'`;
    const actual = await client.query<{ balance: string }>(sql.text, [
      ...sql.values,
    ]);
    expect(Number(actual.rows[0].balance)).toBe(
      refundableBalancePaise(10000, {
        refunds: [{ amountPaise: 2500, status }],
        disputes: [
          { amountPaise: 3000, status: "LOST" },
          { amountPaise: 4000, status: "UNDER_REVIEW" },
        ],
      }),
    );
  },
);
