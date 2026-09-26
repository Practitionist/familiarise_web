/**
 * GET /api/backoffice/nav-counts?tree=admin|staff
 *
 * #1527 Q12 — the queue counts behind the back-office nav badges and the
 * admin "Needs attention" tiles. Read-only. Each count uses the SAME `where`
 * as the page its badge opens (lib/backoffice/queue-predicates.ts, #1345),
 * and only the queues the tree's capability can open are counted.
 *
 * One array `$transaction` of counts: PG_POOL_MAX=1 serialises them anyway,
 * and an array (not interactive) transaction holds no connection between
 * awaits. The refunds queue is post-filtered in code, so it is read after.
 */

import type { PrismaPromise } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { payoutListWhere } from "@/lib/api/operators/payouts";
import {
  can,
  isBackofficeTree,
  resolveBackofficeCapability,
} from "@/lib/backoffice/capability";
import { readRefundNeedsHuman } from "@/lib/backoffice/needs-human";
import {
  DEAD_LETTER_EMAIL_WHERE,
  OPEN_DISPUTE_WHERE,
  OPEN_ERASURE_WHERE,
  ORG_AWAITING_VERIFICATION_WHERE,
  PENDING_CONSULTANT_VERIFICATION_WHERE,
  PENDING_REPORT_WHERE,
  THREAD_QUEUE_WHERE,
  TICKET_QUEUE_FILTERS,
  UNREPORTED_BREACH_WHERE,
  ticketListWhere,
} from "@/lib/backoffice/queue-predicates";
import type { BackofficeBadgeKey } from "@/lib/dashboard/backoffice-nav";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;
  const tree = new URL(req.url).searchParams.get("tree") ?? "";
  const cap = isBackofficeTree(tree)
    ? resolveBackofficeCapability(auth.session.user.role, tree)
    : null;
  if (!cap) {
    return NextResponse.json(
      { error: "Forbidden — insufficient back-office permissions" },
      { status: 403 },
    );
  }

  // [badge, count] pairs; a badge with two sources (verification,
  // compliance) appears twice and is summed below.
  const reads: Array<[BackofficeBadgeKey, PrismaPromise<number>]> = [];
  if (can(cap, "tickets.manage")) {
    reads.push([
      "tickets",
      prisma.supportTicket.count({
        where: ticketListWhere(TICKET_QUEUE_FILTERS),
      }),
    ]);
  }
  if (can(cap, "threads.manage")) {
    reads.push([
      "conversations",
      prisma.appointmentSupportThread.count({ where: THREAD_QUEUE_WHERE }),
    ]);
  }
  if (can(cap, "moderation.manage")) {
    reads.push([
      "moderation",
      prisma.moderationReport.count({ where: PENDING_REPORT_WHERE }),
    ]);
  }
  if (can(cap, "users.verify")) {
    reads.push([
      "verification",
      prisma.consultantProfileVerification.count({
        where: PENDING_CONSULTANT_VERIFICATION_WHERE,
      }),
    ]);
  }
  if (can(cap, "organizations.manage")) {
    reads.push([
      "verification",
      prisma.organization.count({ where: ORG_AWAITING_VERIFICATION_WHERE }),
    ]);
  }
  if (can(cap, "disputes.read")) {
    reads.push([
      "disputes",
      prisma.dispute.count({ where: OPEN_DISPUTE_WHERE }),
    ]);
  }
  if (can(cap, "payouts.read")) {
    reads.push([
      "payouts",
      prisma.consultantPayout.count({
        where: payoutListWhere({ status: "PENDING" }),
      }),
    ]);
  }
  if (can(cap, "compliance.manage")) {
    reads.push(
      [
        "compliance",
        prisma.erasureRequest.count({ where: OPEN_ERASURE_WHERE }),
      ],
      [
        "compliance",
        prisma.dataBreach.count({ where: UNREPORTED_BREACH_WHERE }),
      ],
      [
        "compliance",
        prisma.failedEmail.count({ where: DEAD_LETTER_EMAIL_WHERE }),
      ],
    );
  }

  const values = reads.length
    ? await prisma.$transaction(reads.map(([, read]) => read))
    : [];
  const counts: Partial<Record<BackofficeBadgeKey, number>> = {};
  reads.forEach(([key], i) => {
    counts[key] = (counts[key] ?? 0) + values[i];
  });
  // Only the admin console acts on these (the doors are `refunds.manage`).
  if (can(cap, "refunds.manage")) {
    counts.refunds = (await readRefundNeedsHuman()).length;
  }

  return NextResponse.json({ counts }, { headers: NO_STORE });
}
