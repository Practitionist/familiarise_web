/**
 * /dashboard/organization/[orgId]/my-program — LEARNER's per-org view.
 *
 * Shows what the org is funding for THIS member: which Programs they're
 * assigned to in the current cycle, how much of their cap they've used,
 * and what they've booked under the program. All other org-dashboard
 * pages aggregate across the whole org for operators (MANAGER+); this
 * one is the only consumer-facing in-org surface for LEARNERs.
 *
 * Read-only. No mutations land here in v1. The "request access to a
 * program" flow lives on a future MAINTAINER-approved request endpoint
 * (tracked under #703 Programs v2).
 */

import { notFound, redirect } from "next/navigation";
import Link from "next/link";

import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { formatCurrencyAmount } from "@/utils/formatting";

const PROGRAM_TYPE_LABEL: Record<string, string> = {
  LICENSED_SEAT: "Licensed seat",
  CREDIT_POOL: "Credit pool",
  PROJECT: "Project",
  RETAINER: "Retainer",
};

const OVERAGE_BEHAVIOR_LABEL: Record<string, string> = {
  BLOCK: "Cap is enforced — bookings stop at the limit",
  CHARGE_MEMBER: "Over-cap bookings charged to your own card",
  CHARGE_ORG: "Over-cap bookings billed to the organisation",
};

export default async function MyProgramPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }
  // Pages under canSponsor=false orgs (pure providers) have no programs
  // — surface 404 instead of an empty-state to keep the URL tree honest.
  if (!access.org.canSponsor) {
    notFound();
  }

  const now = new Date();

  // Active assignments for this membership in the current cycle. Latest
  // first so the most recent allocation is on top.
  const assignments = await prisma.programAssignment.findMany({
    where: {
      membershipId: access.member.id,
      periodStart: { lte: now },
      periodEnd: { gte: now },
    },
    orderBy: { periodStart: "desc" },
    include: {
      program: {
        include: {
          licensedSeatConfig: true,
          creditPoolConfig: true,
          contract: { select: { id: true, status: true } },
        },
      },
    },
  });

  // Latest 20 utilizations across this membership's assignments. We
  // pull the assignmentId set first so the WHERE clause stays index-
  // friendly (BookingUtilization is indexed on programAssignmentId).
  const allAssignmentIds = await prisma.programAssignment.findMany({
    where: { membershipId: access.member.id },
    select: { id: true },
  });
  const utilizations = allAssignmentIds.length
    ? await prisma.bookingUtilization.findMany({
        where: {
          programAssignmentId: { in: allAssignmentIds.map((a) => a.id) },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          payment: {
            select: {
              id: true,
              appointment: {
                select: {
                  id: true,
                  appointmentType: true,
                  startTime: true,
                },
              },
            },
          },
        },
      })
    : [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My Program</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {access.org.name} sponsors your bookings through the programs below.
        </p>
      </header>

      {assignments.length === 0 ? (
        <EmptyState orgId={orgId} />
      ) : (
        <section className="space-y-4">
          {assignments.map((a) => {
            const seat = a.program.licensedSeatConfig;
            const pool = a.program.creditPoolConfig;
            const cap =
              a.program.type === "LICENSED_SEAT"
                ? (seat?.coveredSessionsPerCycle ?? null)
                : a.program.type === "CREDIT_POOL"
                  ? (pool?.creditsPerCycle ?? null)
                  : null;
            const used = a.sessionsUsed;
            const pct =
              cap === null ? null : Math.min(100, Math.round((used / cap) * 100));
            const unitLabel =
              a.program.type === "CREDIT_POOL" ? "credits" : "sessions";

            return (
              <div key={a.id} className="rounded-lg border bg-card p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-medium">{a.program.name}</h2>
                    <p className="text-xs text-muted-foreground mt-1">
                      {PROGRAM_TYPE_LABEL[a.program.type] ?? a.program.type} ·
                      cycle {a.periodStart.toLocaleDateString("en-IN")} →{" "}
                      {a.periodEnd.toLocaleDateString("en-IN")}
                    </p>
                  </div>
                  <span className="rounded-full border px-2.5 py-0.5 text-xs">
                    {PROGRAM_TYPE_LABEL[a.program.type] ?? a.program.type}
                  </span>
                </div>

                <div className="mt-4 space-y-2">
                  <div className="flex items-baseline justify-between text-sm">
                    <span>
                      {used.toLocaleString("en-IN")} of{" "}
                      {cap === null
                        ? "unlimited"
                        : `${cap.toLocaleString("en-IN")}`}{" "}
                      {unitLabel} used
                    </span>
                    {cap !== null && (
                      <span className="text-xs text-muted-foreground">
                        {pct}% consumed
                      </span>
                    )}
                  </div>
                  {cap !== null && pct !== null && (
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>

                {seat && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {OVERAGE_BEHAVIOR_LABEL[seat.overageBehavior] ??
                      seat.overageBehavior}
                  </p>
                )}

                {a.program.coveredPlanTypes.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Covers: {a.program.coveredPlanTypes.join(", ").toLowerCase()}
                    {a.program.allowedCategories.length > 0 &&
                      ` · in ${a.program.allowedCategories.join(", ")}`}
                  </p>
                )}

                {a.overageCount > 0 && (
                  <p className="mt-2 text-xs text-amber-700">
                    {a.overageCount.toLocaleString("en-IN")} overage{" "}
                    {a.overageCount === 1 ? "booking" : "bookings"} so far this
                    cycle.
                  </p>
                )}
              </div>
            );
          })}
        </section>
      )}

      {utilizations.length > 0 && (
        <section>
          <h2 className="text-lg font-medium mb-3">Recent activity</h2>
          <div className="overflow-hidden rounded-lg border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium text-right">Consumed</th>
                  <th className="px-4 py-2 font-medium text-right">Price</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {utilizations.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="px-4 py-2">
                      {u.createdAt.toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-2 lowercase">
                      {u.payment.appointment?.appointmentType ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {u.sessionsConsumed}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {formatCurrencyAmount(u.priceAtBookingPaise, "INR")}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {u.reversedAt
                        ? "Reversed"
                        : u.wasOverage
                          ? "Overage"
                          : "Covered"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function EmptyState({ orgId }: { orgId: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="font-medium">No active programs yet</h2>
      <p className="text-sm text-muted-foreground mt-2">
        You're a member of this organisation, but no Program has been assigned
        to your account in the current cycle. Reach out to your org
        administrator to be added to a program.
      </p>
      <Link
        href={`/dashboard/organization/${orgId}/home`}
        className="mt-4 inline-flex text-sm text-primary underline"
      >
        Back to overview
      </Link>
    </div>
  );
}
