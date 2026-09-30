/**
 * @jest-environment node
 */

/**
 * #1319 — the schema-finalization decisions, pinned so a merge conflict cannot
 * silently restore a dropped index or lose a tombstone column.
 */

import fs from "fs";
import path from "path";

const schema = fs.readFileSync(
  path.join(process.cwd(), "prisma/schema.prisma"),
  "utf8",
);

function model(name: string): string {
  const m = new RegExp(`^model ${name} \\{\\n([\\s\\S]*?)^\\}`, "m").exec(
    schema,
  );
  if (!m) throw new Error(`model ${name} not found`);
  return m[1];
}

describe("new booking models", () => {
  it("AppointmentParticipant and BookingStatusHistory exist with their uniques and indexes", () => {
    const p = model("AppointmentParticipant");
    expect(p).toContain("@@unique([appointmentId, userId])");
    expect(p).toContain("@@index([appointmentId, status])");
    expect(p).toContain("@@index([userId, status])");
    expect(p).toContain("@@index([paymentId])");
    const h = model("BookingStatusHistory");
    expect(h).toContain("@@index([entityId, createdAt])");
    expect(h).toContain("entity     BookingHistoryEntity");
  });
});

describe("hygiene", () => {
  it.each([
    "Subscription",
    "Webinar",
    "Class",
    "BookingUtilization",
    "Appointment",
    "AppointmentOccurrence",
    "Payment",
    "Refund",
  ])("%s carries a deletedAt tombstone", (name) => {
    expect(model(name)).toMatch(/deletedAt\s+DateTime\?\s+@db\.Timestamptz/);
  });

  // The mirror of the list above. These six carried a `deletedAt` column that
  // NO code path ever wrote: a request is retired by `status` plus
  // `cancelledAt`, and an availability row is removed by `deleteMany`. Every
  // reader was a `deletedAt: null` filter that could therefore only ever hide
  // nothing — which is the worst kind of filter, because it looks like a
  // liveness test and is not one.
  //
  // Pinning the absence matters as much as pinning the presence above: it is
  // what stops the next person re-adding a filter that reads a column nobody
  // writes, and it is why the corresponding `deletedAt: null` filters had to
  // come out of `lib/data/requests-inbox.ts` and
  // `lib/scheduling/uncovered-upcoming.ts` in the same change.
  it.each([
    "Consultation",
    "Trial",
    "RescheduleRequest",
    "RescheduleProposedTime",
    "AvailabilityWindowWeekly",
    "AvailabilityWindowCustom",
  ])("%s has no deletedAt tombstone, because nothing wrote one", (name) => {
    // Comment-stripped: each of these models now carries a schema comment
    // explaining the removal, and that prose names `deletedAt` — so a naive
    // substring check would pass on the comment and miss the point.
    const fields = model(name)
      .split("\n")
      .map((l) => l.split("//")[0]);
    expect(fields.join("\n")).not.toMatch(/^\s+deletedAt\s/m);
  });

  it("Trial, Webinar and BookingUtilization have no naive DateTime column", () => {
    for (const name of ["Trial", "Webinar", "BookingUtilization"]) {
      const naive = model(name)
        .split("\n")
        .filter(
          (l) =>
            /^\s+\w+\s+DateTime\??(\s|$)/.test(l) &&
            !l.includes("@db.Timestamptz"),
        );
      expect(naive).toEqual([]);
    }
  });

  it("the redundant prefix indexes are gone and the org/deletedAt index exists", () => {
    const a = model("Appointment");
    expect(a).not.toMatch(/@@index\(\[subscriptionId\]\)/);
    expect(a).not.toMatch(/@@index\(\[classId\]\)/);
    expect(a).not.toMatch(/@@index\(\[appointmentType\]\)/);
    expect(a).toContain("@@index([organizationId, deletedAt, createdAt])");
    expect(model("Consultation")).not.toMatch(
      /@@index\(\[consultationPlanId\]\)/,
    );
    expect(model("Consultation")).not.toMatch(/@@index\(\[requestedById\]\)/);
    expect(model("Subscription")).not.toMatch(
      /@@index\(\[subscriptionPlanId\]\)/,
    );
    expect(model("Subscription")).not.toMatch(/@@index\(\[requestedById\]\)/);
  });

  it("cancelledBy is a foreign key on both request models", () => {
    expect(model("Consultation")).toContain(
      '@relation("ConsultationCancelledBy"',
    );
    expect(model("Subscription")).toContain(
      '@relation("SubscriptionCancelledBy"',
    );
  });
});

describe("push chain", () => {
  it("db:push is push → sidecars → assert, with the sidecars applied once", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    expect(pkg.scripts["db:push"]).toBe(
      "npm run db:push:schema && npm run db:assert-sidecars",
    );
    expect(pkg.scripts["db:push:schema"]).toContain("db:sidecars");
  });

  it("the reset applied the once-staged block, so nothing is left commented", () => {
    // #1554 — the STAGED banner and its commented DDL are gone; the reset
    // gave them a clean schema and they are live objects the guard asserts.
    const sql = fs.readFileSync(
      path.join(process.cwd(), "prisma/sql/check-constraints.sql"),
      "utf8",
    );
    expect(sql).not.toContain("STAGED FOR THE PRE-MVP RESET");
    expect(sql).toContain("APPLIED AT THE PRE-MVP RESET");
  });
});
