/**
 * @jest-environment node
 */

/**
 * Wave 1 production-readiness P0s, pinned at the SOURCE level.
 *
 * The mocked unit suites prove each of these fixes works against the prisma
 * mock they were written for. They cannot prove the fix is still THERE: a
 * merge conflict resolved by taking one side drops a call, an argument, or a
 * branch, and every unit suite above keeps passing because the mock it asserts
 * against was written for the fixed shape. These are the pins for that gap —
 * the same idiom as `cas-bypass-regression.test.ts` and
 * `occurrence-overlap-tombstone.test.ts`, which exist because a status write
 * that stops going through a CAS helper is invisible to a test that mocks the
 * helper.
 *
 * Read by `readFileSync`, asserted on text and on CALL COUNTS. Counts, not
 * mere presence: a guard called from only one of the two places that need it
 * is the pre-fix defect wearing the post-fix name, and `toContain` would pass.
 */

import fs from "fs";
import path from "path";

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8");

/**
 * Every `refundBookingPayment(` call in a file, as source slices, so the
 * arguments of each can be checked individually rather than the file as a
 * whole. `Refund` is unique on nothing but `dedupeKey`, so an unkeyed refund's
 * only remaining guard is refundPayment's own read-then-write balance
 * re-derivation — which two concurrent runs both pass.
 */
function refundCallSites(src: string): string[] {
  const sites: string[] = [];
  const open = /refundBookingPayment\(\{/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(src)) !== null) {
    // Walk to the matching brace so a call's arguments cannot borrow the next
    // call's `dedupeKey`.
    let depth = 0;
    let end = match.index + match[0].length;
    for (let i = end - 1; i < src.length; i += 1) {
      if (src[i] === "{") depth += 1;
      else if (src[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    sites.push(src.slice(match.index, end));
  }
  return sites;
}

/**
 * #P0-1 — one consultee, one live session per moment of their calendar.
 *
 * Nothing in the database enforces it: `occurrence_no_confirmed_overlap` is
 * keyed on consultantProfileId, so a learner who books two DIFFERENT
 * consultants for the same hour is invisible to the only DB-level backstop in
 * the system. The predicate read closes the race only on the transaction that
 * WRITES the occurrence, so the in-transaction call is the load-bearing one
 * and the under-lock one is only the cheap early exit.
 */
describe("the consultee guard runs on both paths that can refuse it", () => {
  const src = read("lib/payments/operations/checkout.ts");

  it("is called from the under-lock exit AND from the Serializable write", () => {
    // Four occurrences: the declaration plus three calls — the consultation and
    // subscription arms of revalidateInsideLock (under the distributed lock,
    // committing before anything is written) and the `case "CONSULTATION"` arm
    // of handleCheckout, inside the transaction that writes the occurrence.
    // A fourth call site means a new path reads the predicate; fewer means one
    // of these three stopped reading it.
    expect(
      (src.match(/assertConsulteeHasNoOverlappingSession\(/g) ?? []).length,
    ).toBe(4);
    expect(src).toContain(
      "async function assertConsulteeHasNoOverlappingSession(",
    );
  });

  it("re-asserts it on the tx that writes the occurrence, self-hold and all", () => {
    // The write-side call is inside `handleCheckout`'s `case "CONSULTATION"` —
    // the arm that creates the occurrence. #1463: the buyer's own open order for
    // this window is excluded on this same tx, or the guard reads back the very
    // order the buyer is finishing and refuses it.
    const handler = src.slice(
      src.indexOf("export async function handleCheckout("),
    );
    const guardAt = handler.indexOf("assertConsulteeHasNoOverlappingSession(");
    const writeAt = handler.indexOf("handleConsultationCheckout(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    // The ordering is the fix, not a detail: the predicate read has to precede
    // the occurrence write on the same transaction, because that read is what
    // leaves the rw-dependency a concurrent twin's insert antidepends on and
    // SSI aborts. A guard moved after the write (or above it, in another
    // transaction) closes no race and still passes a `toContain` check.
    expect(guardAt).toBeLessThan(writeAt);
    expect(handler).toContain(
      "selfHoldAppointmentIds: await findSelfHoldAppointmentIds(",
    );
    // And the predicate itself must be a READ on that tx, or SSI has nothing
    // to abort a racing twin on.
    expect(src).toContain("const conflict = await tx.appointment.findFirst({");
  });

  it("still refuses a conflict rather than letting one through", () => {
    expect(src).toContain(
      'throw new Error("You already have a session booked during this time.");',
    );
  });
});

/**
 * #P0-4 — refund dedupe keys.
 *
 * `Refund` is unique on nothing but `dedupeKey`, and every one of these refunds
 * runs from a cron whose `withCronLock` grant can expire mid-run: two
 * overlapping executions then both read `refundable = amount` and both create
 * the row. with-cron-lock states that the CAS guards, not the lock, are the
 * correctness backstop — an unkeyed refund is where that claim was false.
 */
describe("every sweep refund carries a dedupeKey", () => {
  it("expire-stale-requests keys both of its refund sites", () => {
    const src = read("scripts/appointments/expire-stale-requests.ts");
    const sites = refundCallSites(src);
    expect(sites.length).toBe(2);
    for (const site of sites) {
      expect(site).toContain("dedupeKey");
    }
    // The key must be the ARM's name plus the payment, not a key derived from
    // the wrapper: two of the three arms refund subscriptions, so a
    // wrapper-keyed string lets one arm's refund read back as another's
    // already-done work.
    expect(src).toContain(
      "const expiredRefundKey = (arm: ExpiredRefundArm, paymentId: string) =>",
    );
    expect(src).toContain('`${arm}:${paymentId}`');
  });

  it("detect-consultant-no-shows keys its refund", () => {
    const src = read("scripts/appointments/detect-consultant-no-shows.ts");
    const sites = refundCallSites(src);
    expect(sites.length).toBe(1);
    expect(sites[0]).toContain(
      "dedupeKey: `consultant-no-show:${paidPayment.id}`",
    );
  });

  it("settle-cancelled-sessions forwards the key it is given", () => {
    const src = read("scripts/appointments/settle-cancelled-sessions.ts");
    const sites = refundCallSites(src);
    expect(sites.length).toBe(1);
    expect(sites[0]).toContain("dedupeKey: args.dedupeKey");
  });
});

/**
 * #P0-2 — a deadlock is a serialization failure to the caller.
 *
 * Both abort the victim's transaction and both are safe to replay. The pinned
 * driver adapter has no 40P01 case, so a deadlock never arrives as P2034 and
 * surfaced as an unmapped 500 instead of a replay.
 */
describe("withSerializableRetry retries deadlocks as well as SSI aborts", () => {
  it("keeps both predicates in the transient test", () => {
    const src = read("lib/db/serializable-retry.ts");
    expect(src).toContain('import { isDeadlock } from "@/lib/db/pg-errors";');
    expect(src).toContain("isSerializationFailure");
    expect(src).toContain("isDeadlock(error)");
    // The throw is the AND of "neither transient" and "out of attempts": a
    // version that drops the deadlock arm turns every deadlock into a 500.
    expect(src).toMatch(
      /\(!isSerializationFailure && !isDeadlock\(error\)\) \|\|\s*attempt === maxRetries/,
    );
  });

  it("keys the deadlock predicate on the SQLSTATE token, not on prose", () => {
    const src = read("lib/db/pg-errors.ts");
    expect(src).toContain(
      "export function isDeadlock(error: unknown): boolean",
    );
    // A phrase match ("deadlock detected") can promote a business rejection
    // into a retry; 40P01 is the standard code for deadlock_detected and
    // nothing else.
    expect(src).toContain('sqlState(error) === "40P01"');
    expect(src).toContain('adapterCode(error) === "40P01"');
  });
});

/**
 * #P0-5 — a proposal replaces the COVERAGE it released, counted in atoms.
 *
 * The old check compared whole released OCCURRENCES against single-atom
 * PROPOSED rows, so any session longer than 30 minutes could be released and
 * proposed but never accepted — and the shape that DID pass was refused
 * downstream by the allocator's multiples-of-`slotsPerCall` rule.
 */
describe("the proposal count check compares atoms, not rows", () => {
  it("both sides are measured from their own window bounds", () => {
    const src = read("lib/booking/reschedule-proposals.ts");
    expect(src).toContain("export function releasedAtomCount(");
    expect(src).toContain("export function proposedAtomCount(");
    expect(src).toContain("export function proposalCoverageMatches(");
    // One atom length, declared once: a literal "30" here would be a second
    // declaration of the atom the locks and the exclusion are built on.
    expect(src).toContain(
      'import { SCHEDULING_INTERVAL_MS } from "@/lib/appointments/occurrences";',
    );
    expect(src).toContain("Math.round(durationMs / SCHEDULING_INTERVAL_MS)");
  });

  it("the route asks the coverage question, not the row-count one", () => {
    const route = read(
      "app/api/appointments/[appointmentId]/reschedule/route.ts",
    );
    expect(route).toContain(
      "!proposalCoverageMatches(slotsToReschedule, proposedSlots)",
    );
    expect(route).not.toContain("proposalCountMatches(");
  });
});

/**
 * #1846 — a decline is a restoring exit.
 *
 * It was a status transition and nothing else, which left the parent in the
 * PENDING that `expireUnallocatedPaidSubscriptions` selects (paid, zero live
 * sessions, no open proposal) — and the decline is what removed the proposal
 * from that cohort, so a consultant saying "no, not that time" ended with the
 * platform refunding the buyer in full 48 hours later.
 */
describe("a decline restores rather than strands", () => {
  it("restores through the shared helper and never asserts nothing else", () => {
    const src = read("lib/booking/reschedule-respond.ts");
    expect(src).toContain("restoreRescheduledBooking(tx, request, {");
    // The pre-#1846 contract, in the words it was written in: a decline that
    // deliberately left the slots released. The sentence is a docstring, and a
    // docstring is how the next reader learns the rule.
    expect(src).not.toContain(
      "deliberately leaves the released slots released",
    );
    // What replaced it: the outcome is decided by how much came back.
    expect(src).toContain(
      "const restoredFully = restored === request.releasedOccurrenceIds.length;",
    );
    // The guard the restore needs, and the fallback for when it cannot land.
    expect(src).toContain("if (!isRestoreMiss(err)) throw err;");
    expect(src).toContain("parkParentForUnrestoredEnding(tx, request, {");
    // The DECLINED still commits when the restore cannot: someone decided, and
    // re-offering the proposal because their old time is gone would ask the
    // same person the same question again.
    expect(src).toContain("restoreMiss = err;");
  });

  it("is one definition of a restore miss, not two", () => {
    // The sweep and the decline must ask the same question; a second copy in
    // scripts/appointments/expire-reschedule-proposals.ts is how one of them
    // ends up answering a slightly different one.
    const lib = read("lib/booking/reschedule-restore.ts");
    expect(lib).toContain(
      "export function isRestoreMiss(error: unknown): boolean",
    );
    const sweep = read("scripts/appointments/expire-reschedule-proposals.ts");
    expect(sweep).toContain("isRestoreMiss,");
    expect(sweep).not.toContain("function isRestoreMiss(");
  });

  it("tells the counterparty which of the two outcomes it got", () => {
    // The route's fixed sentence named the stranded case for every successful
    // decline, including the common one where the slots were just restored.
    const route = read(
      "app/api/appointments/[appointmentId]/reschedule/respond/route.ts",
    );
    expect(route).not.toContain(
      "The released times stay in the allocate queue until new times are placed.",
    );
    expect(route).toContain(
      'type RescheduleRespondCode = "DECLINED" | "RELEASED";',
    );
    // The sentence is looked up by the code, so the two cannot disagree.
    expect(route).toContain("message: DECLINE_OUTCOME_COPY[outcome],");
    expect(route).toContain("countRestoredOccurrences(");
  });
});

/**
 * #1846 — a capture that lands on a full room is given back, and the gate
 * reads a real capacity. The optional chain this replaced existed only so a
 * bare `jest.fn()` capacity mock could not throw inside a transaction that
 * already holds the capture stamp; treating "no reading" as "room available" is
 * the more expensive of the two failures, so it is pinned shut.
 */
describe("the legacy group-event creators capacity-gate on a real reading", () => {
  const src = read("lib/payments/webhooks/handlers.ts");

  it("gates both group-event arms", () => {
    expect(src).toContain("const capacity = getWebinarCapacity({");
    expect(src).toContain("const capacity = getClassCapacity({");
    expect((src.match(/if \(capacity\.isFull\) \{/g) ?? []).length).toBe(2);
    expect(src).not.toMatch(/if \(capacity\?\.isFull\)/);
  });
});
