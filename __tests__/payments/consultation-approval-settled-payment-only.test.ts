/**
 * @jest-environment node
 */

/**
 * #1775 B-9 — a PENDING pay-link order is a hold, not a payment.
 *
 * The consultation approval route's `checkConsultationPayment` matched
 * `paymentStatus in [SUCCEEDED, PENDING]`, so an order nobody had paid for
 * counted as a payment. On approve the route then took the settled branch:
 * it CONFIRMED the occurrence (`isTentative: false`) and returned without
 * minting anything, leaving wrapper `APPROVED` + a confirmed slot + a
 * `PENDING`/`EXPIRED` `Payment` + no pay link.
 *
 * Nothing reaps that shape. Every sweep cohort needs either a tentative
 * occurrence or an `APPROVED_PENDING_PAYMENT`/`PENDING` request, and this row
 * has neither, so the consultant's minutes stayed blocked by the GiST
 * exclusion forever while a buyer who never paid held a confirmed slot.
 *
 * The subscription twin already had this right — it reads `SETTLED_SUBSCRIPTION`,
 * which admits SUCCEEDED and a free plan and nothing else. This is the same
 * predicate, and it is a source-text contract because the helper is private to
 * the route: a behavioural test would have to drive the whole approval
 * transaction, while this fails the moment a PENDING is admitted again.
 */

import fs from "fs";
import path from "path";

const ROUTE =
  "app/api/bookings/consultations/[consultationId]/route.ts";
const source = fs.readFileSync(path.resolve(__dirname, "../..", ROUTE), "utf8");

/** The predicate body, from the helper's own signature. */
function helperBody(): string {
  const start = source.indexOf("async function checkConsultationPayment(");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

/**
 * The index of the `}` that closes the block opened at `from`.
 *
 * `from` must name a line that OPENS a block, and the text between the braces
 * carries no literal or comment braces — true of every block this file slices,
 * and asserted by the caller so a future edit that breaks it fails here rather
 * than silently narrowing the window.
 */
function indexOfClosingBrace(text: string, from: number): number {
  const open = text.indexOf("{", from);
  expect(open).toBeGreaterThan(from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  // Unbalanced source: fail rather than hand back a window that reaches the end
  // of the file, which would assert against code outside the arm entirely.
  return -1;
}

describe("the consultation approval route admits only a settled payment", () => {
  it("never lists PENDING as a payment", () => {
    // The regression in one assertion. `in: [SUCCEEDED, PENDING]` is gone.
    expect(helperBody()).not.toMatch(/PaymentStatus\.PENDING/);
    expect(helperBody()).not.toMatch(/paymentStatus:\s*\{/);
  });

  it("matches SUCCEEDED on its own", () => {
    expect(helperBody()).toMatch(
      /paymentStatus:\s*PaymentStatus\.SUCCEEDED/,
    );
  });

  it("agrees with the predicate the subscription twin already used", () => {
    // `SETTLED_CONSULTATION` / `SETTLED_SUBSCRIPTION` are SUCCEEDED (or a free
    // plan). If the two approval writers drift, one of them starts confirming
    // slots nobody paid for.
    const twin = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../app/api/bookings/subscriptions/[subscriptionId]/route.ts",
      ),
      "utf8",
    );
    expect(twin).toMatch(/SETTLED_SUBSCRIPTION/);
    const policy = fs.readFileSync(
      path.resolve(__dirname, "../../lib/booking/approve-request.ts"),
      "utf8",
    );
    expect(policy).toMatch(
      /some:\s*\{\s*paymentStatus:\s*PaymentStatus\.SUCCEEDED/,
    );
  });
});

describe("the unpaid arm is reachable again", () => {
  it("still transitions to APPROVED_PENDING_PAYMENT and reports needsPaymentLink", () => {
    // A PENDING order now falls through to the unpaid branch, which is only
    // correct if that branch does its job: record the approval as awaiting
    // payment and ask for the mint.
    expect(source).toMatch(
      /to:\s*AppointmentStatus\.APPROVED_PENDING_PAYMENT/,
    );
    expect(source).toMatch(/needsPaymentLink:\s*true/);
    expect(source).toMatch(/mintApprovalPaymentAfterCommit\(\{/);
  });

  it("still confirms the hold only on the settled branch", () => {
    // `isTentative: false` is the write that made the stranded shape. It must
    // stay inside the `if (hasPayment)` arm, not beside it.
    //
    // The arm's own `} else {` is NOT the first one after it: the settled
    // branch contains a nested `if (consultation.appointment) { … } else {`, so
    // slicing to the first match stopped the window INSIDE the arm. The
    // assertion passed only because the write happens to sit above that nested
    // else — move it anywhere below and the pin fires on a line that is still
    // inside the arm it is supposed to be protecting. Brace-match to the arm's
    // real boundary instead.
    const start = source.indexOf("if (hasPayment) {");
    expect(start).toBeGreaterThan(-1);
    const end = indexOfClosingBrace(source, start);
    expect(end).toBeGreaterThan(start);
    const settledBranch = source.slice(start, end);
    expect(settledBranch).toMatch(/isTentative: false/);
  });
});
