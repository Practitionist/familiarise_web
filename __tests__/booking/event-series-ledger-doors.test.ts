/**
 * @jest-environment node
 */

/**
 * #1780 D-5 — every whole-event refund door must supply the class ledger.
 *
 * `refundWholeEventPayments` accepts `opts.ledgers`, and only when it is present
 * does `seriesAmount` net each seat to `amount − unit × deliveredHeld` (less
 * what an `occ:` session refund already returned). Absent — or an empty map, which
 * is the same answer — every rail treats the seat as owing its whole balance.
 *
 * The appointment cancel route has passed the ledger since D-5. Two doors did
 * not, and both refunded a partly-delivered class in full: moderation's
 * whole-event cancel, and the admin refunds button. Eight sessions into a
 * ten-session class, a ban or an ops refund handed back all ten — the consultant
 * kept nothing for the eight that were taught and the buyer kept the two that
 * were not.
 *
 * This is a source-text contract, the same shape as
 * `__tests__/payments/appointment-delete-forbidden.test.ts`: a mock-based test
 * would only prove the one call site it happened to drive, whereas this fails the
 * moment a fourth door forgets the ledger.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

const read = (relative: string) =>
  fs.readFileSync(path.join(ROOT, relative), "utf8");

/**
 * Every source file that CALLS the whole-event front door. A new caller that is
 * not listed here is invisible to the contract, so the last case fails rather
 * than passing vacuously.
 */
const DOORS = [
  "app/api/appointments/[appointmentId]/cancel/route.ts",
  "lib/moderation/cancel-user-engagements.ts",
  "app/api/admin/refunds/route.ts",
];

/** The doors plus the preview, which quotes the series but refunds nothing. */
const LEDGER_READERS = [
  ...DOORS,
  "app/api/appointments/[appointmentId]/cancel/preview/route.ts",
];

describe("every whole-event refund door supplies the class ledger", () => {
  it.each(DOORS)("%s passes the ledger to the front door", (door) => {
    const source = read(door);
    // The call carries the ledger, or it is the whole-balance answer.
    expect(source).toMatch(/refundWholeEventPayments\([\s\S]*?\{\s*ledgers:/);
  });

  it.each(LEDGER_READERS)("%s has classSeriesLedgers in scope", (door) => {
    expect(read(door)).toMatch(/classSeriesLedgers/);
  });

  it("no other source file calls the whole-event front door", () => {
    // Guard the allowlist above: a fifth door added without a ledger must show
    // up here, not slip past the `it.each`.
    const found: string[] = [];
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), {
        withFileTypes: true,
      })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (
            ["node_modules", ".next", ".git", "__tests__"].includes(entry.name)
          )
            continue;
          scan(rel);
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          fs.readFileSync(path.join(ROOT, rel), "utf8").includes(
            "refundWholeEventPayments(",
          )
        ) {
          found.push(rel);
        }
      }
    };
    for (const dir of ["app", "lib", "scripts", "jobs", "utils"]) scan(dir);
    // The definition itself is the one non-door.
    expect(found.sort()).toEqual(
      ["lib/payments/operations/event-refunds.ts", ...DOORS].sort(),
    );
  });
});

describe("the ledger is read before the release that would erase it", () => {
  it("moderation reads it ahead of the occurrence release", () => {
    // `seatLedger` counts only rows with `deletedAt: null`, and
    // `casCancelGroupEvent` tombstones the sessions inside its transaction. A
    // read taken after the release sees an empty series, every seat's
    // `deliveredHeld` reads 0, and the netting silently degrades to a full
    // refund — the exact bug, one line out of position.
    const source = read("lib/moderation/cancel-user-engagements.ts");
    const readAt = source.indexOf("readClassSeriesLedgers(eventId, ctx)");
    // The CALL site, not the definition above it.
    const releaseAt = source.indexOf("await casCancelGroupEvent(");
    expect(readAt).toBeGreaterThan(-1);
    expect(releaseAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(releaseAt);
  });

  it("the admin door has no release to get wrong", () => {
    // It refunds without cancelling, so every occurrence is still live and the
    // read order cannot matter there.
    const source = read("app/api/admin/refunds/route.ts");
    expect(source).not.toMatch(/transitionOccurrenceCompletion/);
    expect(source).not.toMatch(/appointmentOccurrence\.updateMany/);
  });
});

describe("the ledger is only read for a class", () => {
  it("moderation skips it for a webinar", () => {
    // A webinar still refunds every seat in full by design (D-5), so there is
    // no ledger to read — and reading one would net a webinar's attendees down
    // for a series that has no unit price.
    const source = read("lib/moderation/cancel-user-engagements.ts");
    expect(source).toMatch(/isWebinar\s*\n?\s*\?\s*null\s*\n?\s*:\s*await readClassSeriesLedgers/);
  });

  it("the admin door keys it off classId", () => {
    const source = read("app/api/admin/refunds/route.ts");
    expect(source).toMatch(/body\.classId \? await classSeriesLedgers\(eventId\) : null/);
  });
});
