/**
 * The back-office refunds and disputes tables rendered a literal "₹NaN".
 *
 * `Refund` and `Dispute` both store money in a column called `amountPaise`,
 * and the money Prisma extension computes that column to a Number still in
 * paise. The hand-written client interfaces declared `amount` instead — a
 * field no payload has ever carried — so every row formatted `undefined`.
 *
 * The refunds page compounded it by passing the value to
 * `formatCurrencyFromMajorUnit`, which expects rupees. Had `amount` existed in
 * paise, that table would have shown every refund at 100× its true value,
 * which is the worse failure: ₹NaN is obviously broken, ₹2,50,000 where the
 * truth is ₹2,500 is not.
 *
 * These interfaces are hand-written rather than generated, so `tsc` cannot
 * catch the drift — it happily typechecks a lie about the payload. This test
 * is the thing that does, by reading the schema and the interfaces and
 * requiring them to name the same field.
 */

import { readFileSync } from "fs";
import { join } from "path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const SCHEMA = read("prisma/schema.prisma");

/** The money column a Prisma model actually declares. */
function schemaMoneyField(model: string): string {
  const block = SCHEMA.slice(
    SCHEMA.indexOf(`model ${model} {`),
    SCHEMA.indexOf("\n}", SCHEMA.indexOf(`model ${model} {`)),
  );
  const match = block.match(/^\s+(amount|amountPaise)\s+BigInt/m);
  expect(match).not.toBeNull();
  return match![1];
}

/** The money field a hand-written TS interface declares. */
function interfaceMoneyField(src: string, name: string): string {
  const start = src.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("\n}", start));
  const match = block.match(/^\s+(amount|amountPaise)(\?)?:\s*number/m);
  expect(match).not.toBeNull();
  return match![1];
}

describe("client money interfaces name the field the schema declares", () => {
  it.each([
    ["Refund", "types/payments.ts", "Refund"],
    ["Dispute", "types/payments.ts", "Dispute"],
    ["Dispute", "types/disputes.ts", "Dispute"],
    ["Dispute", "types/disputes.ts", "DisputeDetails"],
  ])("%s (schema) matches %s → %s", (model, file, iface) => {
    expect(interfaceMoneyField(read(file), iface)).toBe(
      schemaMoneyField(model),
    );
  });

  it("Payment really does declare a bare `amount`, so its readers stay correct", () => {
    // Guards against an over-eager sweep renaming every money field to
    // `*Paise`: the invoices and subscriptions tables read Payment.amount and
    // are correct today.
    expect(schemaMoneyField("Payment")).toBe("amount");
  });
});

describe("paise values reach a paise formatter", () => {
  const PAISE_PAGES = [
    "components/dashboard/shared/RefundsPage.tsx",
    "components/dashboard/shared/DisputesPage.tsx",
    "components/dashboard/shared/DisputeDetailPage.tsx",
  ];

  it.each(PAISE_PAGES)("%s renders the amountPaise field", (rel) => {
    const src = read(rel);
    expect(src).toMatch(/format\w*\(\s*(refund|dispute)\.amountPaise/);
  });

  it("RefundsPage does not use the major-unit formatter", () => {
    // The unit half of the bug. `formatCurrencyFromMajorUnit` takes rupees;
    // everything on this page is paise.
    expect(read(PAISE_PAGES[0])).not.toContain(
      "formatCurrencyFromMajorUnit(refund",
    );
  });
});
