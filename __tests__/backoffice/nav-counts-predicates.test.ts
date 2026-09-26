/**
 * #1527 Q12 / #1345 — every back-office nav badge counts the SAME `where` as
 * the page it opens. The builders live in lib/backoffice/queue-predicates.ts;
 * this pins that both the badge route and each page's own route use them.
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  DEAD_LETTER_EMAIL_WHERE,
  TICKET_QUEUE_FILTERS,
  ticketListWhere,
} from "@/lib/backoffice/queue-predicates";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const NAV_COUNTS = read("app/api/backoffice/nav-counts/route.ts");

// [the shared name, the page-side file that must use it]
const SHARED: Array<[string, string]> = [
  ["ticketListWhere", "app/api/staff/support-tickets/route.ts"],
  ["THREAD_QUEUE_WHERE", "app/api/staff/support-threads/route.ts"],
  ["PENDING_REPORT_WHERE", "app/api/staff/moderation/stats/route.ts"],
  [
    "PENDING_CONSULTANT_VERIFICATION_WHERE",
    "app/api/staff/moderation/stats/route.ts",
  ],
  ["ORG_AWAITING_VERIFICATION_WHERE", "app/api/admin/organizations/route.ts"],
  ["OPEN_DISPUTE_WHERE", "app/api/admin/disputes/route.ts"],
  ["payoutListWhere", "lib/api/operators/payouts.ts"],
  ["OPEN_ERASURE_WHERE", "app/api/admin/erasure-requests/route.ts"],
  ["UNREPORTED_BREACH_WHERE", "app/api/admin/data-breaches/route.ts"],
  ["readRefundNeedsHuman", "app/api/admin/refunds/needs-human/route.ts"],
];

describe("nav badges reuse their page's predicate", () => {
  it.each(SHARED)("%s is used by the badge route and %s", (name, page) => {
    expect(NAV_COUNTS).toContain(name);
    expect(read(page)).toContain(name);
  });

  it("the Tickets badge is the Unassigned view of open tickets", () => {
    expect(ticketListWhere(TICKET_QUEUE_FILTERS)).toEqual({
      status: "OPEN",
      assignedToId: null,
    });
  });

  it("the failed-emails tab opens on the badge's dead-letter state", () => {
    expect(DEAD_LETTER_EMAIL_WHERE).toEqual({ status: "DEAD_LETTER" });
    expect(
      read(
        "app/dashboard/(backoffice)/[tree]/compliance/CompliancePageClient.tsx",
      ),
    ).toContain('useState<string | null>("DEAD_LETTER")');
  });

  it("answers private, never-cached counts", () => {
    expect(NAV_COUNTS).toContain('"Cache-Control": "private, no-store"');
    expect(NAV_COUNTS).toContain("prisma.$transaction(");
  });
});
