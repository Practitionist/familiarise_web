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

import { requireOrgAccess } from "@/lib/auth-helpers";
import { formatCurrencyAmount } from "@/utils/formatting";
import { getMyProgramData } from "@/lib/data/org-member-program";

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

  const {
    assignments,
    utilizations,
    upcomingSessions,
    outstandingOveragePaise,
    overagePaiseByAssignment,
    eligiblePrograms,
  } = await getMyProgramData({
    orgId,
    membershipId: access.member.id,
    userId: access.member.userId,
    consulteeProfileId: access.member.consulteeProfileId,
  });

  // Deep-link to the learner's appointments tab scoped to THIS org so
  // org-funded sessions show. /dashboard alone lands on /home which has no
  // OrgContextFilter and defaults to personal scope, hiding the rows.
  const appointmentsHref = access.member.consulteeProfileId
    ? `/dashboard/consultee/${access.member.consulteeProfileId}/appointments?orgScope=${orgId}`
    : `/dashboard?orgScope=${orgId}`;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">My Program</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {access.org.name} sponsors your bookings through the programs below.
        </p>
      </header>

      {/* #777 §C.5/§F — outstanding overage deep-link banner. */}
      {outstandingOveragePaise > 0 && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div>
            <p className="font-medium text-amber-900">
              You have {formatCurrencyAmount(outstandingOveragePaise, "INR")} in
              outstanding overage charges
            </p>
            <p className="mt-1 text-xs text-amber-800">
              These are over-cap bookings billed to you. Settle them to keep
              your program access active.
            </p>
          </div>
          <Link
            href="/dashboard/overage"
            className="shrink-0 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white"
          >
            Settle now
          </Link>
        </div>
      )}

      {/* #748 — upcoming org-funded sessions for this learner */}
      {upcomingSessions.length > 0 && (
        <section>
          <h2 className="text-lg font-medium mb-3">Upcoming sessions</h2>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">When</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Session</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Type</th>
                  <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Join</th>
                </tr>
              </thead>
              <tbody>
                {upcomingSessions.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="px-4 py-2 whitespace-nowrap">
                      {s.startsAt.toLocaleString("en-IN", {
                        timeZone: "Asia/Kolkata", // RSC renders in UTC otherwise
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2">{s.title}</td>
                    <td className="px-4 py-2 lowercase whitespace-nowrap">{s.type}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {/* Real join needs the Stream client (consultee
                          dashboard). Gate the link to the 10-min window. */}
                      {s.joinable ? (
                        <Link
                          href={appointmentsHref}
                          className="inline-flex rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                        >
                          Join now
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Not yet
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Join from your{" "}
            <Link href={appointmentsHref} className="underline text-primary">
              dashboard
            </Link>{" "}
            when the room opens (within 10 minutes of the start time).
          </p>
        </section>
      )}

      {assignments.length === 0 ? (
        <EmptyState orgId={orgId} />
      ) : (
        <section className="space-y-4">
          {assignments.map((a) => {
            const seat = a.program.licensedSeatConfig;
            const pool = a.program.creditPoolConfig;
            const cap =
              a.program.type === "LICENSED_SEAT"
                ? (seat?.coveredEngagementsPerCycle ?? null)
                : a.program.type === "CREDIT_POOL"
                  ? (pool?.creditBudgetPerCycle ?? null)
                  : null;
            const used = a.engagementsUsed;
            const pct =
              cap === null ? null : Math.min(100, Math.round((used / cap) * 100));
            const remaining = cap === null ? null : Math.max(0, cap - used);
            const unitLabel =
              a.program.type === "CREDIT_POOL" ? "credits" : "sessions";
            const overagePaise = overagePaiseByAssignment[a.id] ?? 0;

            return (
              <div key={a.id} className="rounded-lg border bg-card p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-medium">{a.program.name}</h2>
                    <p className="text-xs text-muted-foreground mt-1">
                      {PROGRAM_TYPE_LABEL[a.program.type] ?? a.program.type} ·
                      cycle{" "}
                      {a.periodStart.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}{" "}
                      →{" "}
                      {a.periodEnd.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}
                    </p>
                  </div>
                  <span className="rounded-full border px-2.5 py-0.5 text-xs">
                    {PROGRAM_TYPE_LABEL[a.program.type] ?? a.program.type}
                  </span>
                </div>

                {/* #777 §C.4 — promote remaining to a prominent banner. */}
                <div
                  className={
                    "mt-4 rounded-md border px-4 py-3 " +
                    (cap !== null && remaining === 0
                      ? "border-amber-300 bg-amber-50"
                      : "border-primary/30 bg-primary/5")
                  }
                >
                  <p className="text-2xl font-semibold leading-none">
                    {cap === null
                      ? "Unlimited"
                      : `${remaining!.toLocaleString("en-IN")} of ${cap.toLocaleString("en-IN")}`}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {cap === null
                      ? `${unitLabel} available — no cap this cycle`
                      : `${unitLabel} ${a.program.type === "CREDIT_POOL" ? "remaining" : "left"} this cycle`}
                  </p>
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
                    {cap === null
                      ? "Unlimited — no cap"
                      : (OVERAGE_BEHAVIOR_LABEL[seat.overageBehavior] ??
                        seat.overageBehavior)}
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
                    cycle
                    {overagePaise > 0 && (
                      <>
                        {" "}
                        ·{" "}
                        <span className="font-medium">
                          {formatCurrencyAmount(overagePaise, "INR")} to settle
                        </span>{" "}
                        ·{" "}
                        <Link
                          href="/dashboard/overage"
                          className="underline"
                        >
                          pay now
                        </Link>
                      </>
                    )}
                    .
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
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">When</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Type</th>
                  <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Consumed</th>
                  <th className="px-4 py-2 font-medium text-right whitespace-nowrap">Price</th>
                  <th className="px-4 py-2 font-medium whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody>
                {utilizations.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="px-4 py-2 whitespace-nowrap">
                      {u.createdAt.toLocaleDateString("en-IN", {
                        timeZone: "Asia/Kolkata",
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-2 lowercase whitespace-nowrap">
                      {u.payment.appointment?.appointmentType ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {u.engagementsConsumed}
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {formatCurrencyAmount(u.priceAtBookingPaise, "INR")}
                    </td>
                    <td className="px-4 py-2 text-xs whitespace-nowrap">
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

      {/* #777 §C.2 (SCHEMA-FREE) — discovery of programs the learner isn't on
          yet but the org actively runs. Read-only; assignment is a MAINTAINER
          action, so we hint rather than wire a new request workflow. */}
      {eligiblePrograms.length > 0 && (
        <section>
          <h2 className="text-lg font-medium mb-3">Other programs at this org</h2>
          <div className="space-y-2">
            {eligiblePrograms.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
              >
                <div>
                  <p className="font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {PROGRAM_TYPE_LABEL[p.type] ?? p.type} · you're not assigned
                    to this yet
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  Ask your admin to assign you
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            These programs are active under {access.org.name}, but only an org
            administrator can add you. Reach out to them to request access.
          </p>
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
