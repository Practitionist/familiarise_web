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

import { redirect } from "next/navigation";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";

import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { formatCurrencyAmount } from "@/utils/formatting";
import { getMyProgramData } from "@/lib/data/org-member-program";
import { getOrgMemberCatalog } from "@/lib/data/org-member-catalog";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { EmptyState as EmptyBlock } from "@/components/dashboard/EmptyState";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { humanizeEnum } from "@/lib/ui/tone";

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

const LEAVE_ERROR_COPY: Record<string, string> = {
  SOLE_OWNER:
    "You are the sole owner of this organization. Transfer ownership before leaving.",
  MEMBER_HAS_OBLIGATIONS:
    "You still have upcoming sessions or money in progress under this organization. Settle or cancel those before leaving.",
  NOT_A_MEMBER: "You are no longer an active member of this organization.",
  ACCESS_DENIED: "Unable to verify organization access for leaving.",
  LEAVE_FAILED:
    "We could not complete your request to leave this organization. Please try again.",
};

export default async function MyProgramPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{ leaveError?: string }>;
}) {
  const { orgId } = await params;
  const resolvedSearch = searchParams ? await searchParams : undefined;
  const leaveError =
    typeof resolvedSearch?.leaveError === "string"
      ? (LEAVE_ERROR_COPY[resolvedSearch.leaveError] ?? null)
      : null;
  const access = await requireOrgAccess(orgId, { readOnly: true });
  // Same grant as the nav item (#1527): the sponsored member's own page.
  if (access.error || !hasOrgPermission(access.member.role, "myProgram.read")) {
    redirect(`/dashboard/organization/${orgId}/home`);
  }
  // #1527 — a host-only org sponsors nothing: explain instead of a 404
  // (and keep the not-found swap out of this route, #1445).
  if (!access.org.canSponsor) {
    return (
      <>
        <DashboardHeader title="My Program" />
        <DashboardContent>
          <EmptyBlock
            variant="page"
            title="No sponsored programs here"
            description={`${access.org.name} doesn't sponsor sessions, so there is no program to show. Sessions you attend under it are in Appointments.`}
            action={
              <Link
                href={`/dashboard/organization/${orgId}/appointments`}
                className="text-sm font-medium underline underline-offset-2"
              >
                Open Appointments
              </Link>
            }
          />
        </DashboardContent>
      </>
    );
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

  // The org's own offerings. Separate from Programs: a Program is the
  // entitlement that FUNDS a booking, this is the catalog of things to book.
  // Only reachable here — ORG_ONLY plans are filtered out of /explore/** by
  // design, so without this panel they have no buyer-facing surface at all.
  const orgCatalog = await getOrgMemberCatalog(orgId);

  // Stay inside the org dashboard. This used to deep-link into the personal
  // consultee dashboard with `?orgScope=<orgId>`, which stopped working when
  // #1023 pinned personal scope to `organizationId: null` — org-funded
  // sessions were exactly what that link was meant to show, and exactly what
  // the personal dashboard now excludes. The org appointments page's "mine"
  // scope is the surface that actually holds them.
  const appointmentsHref = `/dashboard/organization/${orgId}/appointments?scope=mine`;
  const primaryProgramId = assignments[0]?.program.id;
  let browseCoveredHref = "/explore/experts";
  let browseCoveredLabel = "Browse experts";
  if (primaryProgramId) {
    browseCoveredHref = `/explore/experts?program=${primaryProgramId}`;
    browseCoveredLabel = "Browse covered experts";
  } else if (orgCatalog.length > 0) {
    browseCoveredHref = "#org-catalog";
    browseCoveredLabel = "Browse org offerings";
  }

  return (
    <>
      <DashboardHeader
        title="My Program"
        description={`${access.org.name} sponsors your bookings through the programs below.`}
        actions={
          <Button asChild size="sm">
            <Link href={browseCoveredHref}>{browseCoveredLabel}</Link>
          </Button>
        }
      />
      <DashboardContent>
        <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/30">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-400" />
          <div className="text-xs text-emerald-900 dark:text-emerald-200">
            <p className="font-semibold">
              Session Privacy &amp; Organization Visibility
            </p>
            <p className="mt-0.5 text-emerald-800/90 dark:text-emerald-300/90">
              Your session recordings, chat messages, session notes, and
              individual ratings remain strictly private between you and your
              expert. {access.org.name} administrators can see your program seat
              assignment, session count and attendance status, and sponsor or
              reimbursement ledger entries, as described in our{" "}
              <Link href="/privacy" className="underline underline-offset-2">
                Privacy Notice
              </Link>
              .
            </p>
          </div>
        </div>

        {/* #777 §C.5/§F — outstanding overage deep-link banner. */}
        {outstandingOveragePaise > 0 && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <div>
              <p className="font-medium text-amber-900">
                You have {formatCurrencyAmount(outstandingOveragePaise, "INR")}{" "}
                in outstanding overage charges
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
                    <th className="px-4 py-2 font-medium whitespace-nowrap">
                      When
                    </th>
                    <th className="px-4 py-2 font-medium whitespace-nowrap">
                      Session
                    </th>
                    <th className="px-4 py-2 font-medium whitespace-nowrap">
                      Type
                    </th>
                    <th className="px-4 py-2 font-medium text-right whitespace-nowrap">
                      Join
                    </th>
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
                      <td className="px-4 py-2 whitespace-nowrap">
                        {humanizeEnum(s.type)}
                      </td>
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
          <EmptyState
            orgId={orgId}
            browseHref={browseCoveredHref}
            browseLabel={browseCoveredLabel}
          />
        ) : (
          <section className="space-y-4">
            {assignments.map((a) => {
              const seat = a.program.licensedSeatConfig;
              const pool = a.program.creditPoolConfig;
              // The two program types meter on DIFFERENT axes, and this used
              // `engagementsUsed` for both — so a CREDIT_POOL learner who had
              // spent ₹49,500 of a ₹50,000 budget over 3 bookings was shown
              // "49,997 of 50,000 credits remaining · 1% consumed", and then
              // hard-blocked on the next booking. The server meters pools in
              // paise (`consumedPaise` vs `creditBudgetPerCycle * 100`, see the
              // schema doc on ProgramAssignment); only LICENSED_SEAT counts
              // engagements. Both are normalised to the pool's own unit here:
              // whole-rupee credits, where 1 credit = ₹1 = 100 paise.
              const isPool = a.program.type === "CREDIT_POOL";
              let cap: number | null = null;
              if (isPool) {
                cap = pool?.creditBudgetPerCycle ?? null;
              } else if (a.program.type === "LICENSED_SEAT") {
                cap = seat?.coveredEngagementsPerCycle ?? null;
              }
              const used = isPool
                ? Math.round(Number(a.consumedPaise ?? 0) / 100)
                : a.engagementsUsed;
              // ceil, not round (#752) — "1 of 10,000 used" must read 1%, never
              // a pool-looks-untouched 0%. cap=0 can't pass Zod (min 1) but a
              // hand-written row must not render Infinity%.
              const pct =
                cap === null || cap === 0
                  ? null
                  : Math.min(100, Math.ceil((used / cap) * 100));
              const remaining = cap === null ? null : Math.max(0, cap - used);
              const unitLabel =
                a.program.type === "CREDIT_POOL" ? "credits" : "sessions";
              const overagePaise = overagePaiseByAssignment[a.id] ?? 0;
              const poolRateNote = isPool ? " (1 credit = ₹1)" : "";
              const remainingWord =
                a.program.type === "CREDIT_POOL" ? "remaining" : "left";
              const availabilitySummary =
                cap === null
                  ? `${unitLabel} available — no cap this cycle${poolRateNote}`
                  : `${unitLabel} ${remainingWord} this cycle${poolRateNote}`;
              const daysUntilReset = Math.max(
                0,
                Math.ceil(
                  (a.periodEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
                ),
              );

              return (
                <div key={a.id} className="rounded-lg border bg-card p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="font-medium">{a.program.name}</h2>
                      <p className="text-xs text-muted-foreground mt-1">
                        {PROGRAM_TYPE_LABEL[a.program.type] ?? a.program.type} ·
                        cycle{" "}
                        {a.periodStart.toLocaleDateString("en-IN", {
                          timeZone: "Asia/Kolkata",
                        })}{" "}
                        →{" "}
                        {a.periodEnd.toLocaleDateString("en-IN", {
                          timeZone: "Asia/Kolkata",
                        })}{" "}
                        · resets in {daysUntilReset}{" "}
                        {daysUntilReset === 1 ? "day" : "days"}
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
                      {availabilitySummary}
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
                    {cap !== null && pct !== null && <Progress value={pct} />}
                  </div>

                  {/* Was rendered for LICENSED_SEAT only, so a CREDIT_POOL
                    learner saw a budget with no indication of what happens at
                    the limit. Under CHARGE_MEMBER the cap isn't a stop — it's
                    the point where their own card starts being charged, which
                    they should know before they book. */}
                  {(seat ?? pool) && (
                    <p className="mt-3 text-xs text-muted-foreground">
                      {cap === null
                        ? "Unlimited — no cap"
                        : (OVERAGE_BEHAVIOR_LABEL[
                            (seat ?? pool)!.overageBehavior
                          ] ?? (seat ?? pool)!.overageBehavior)}
                    </p>
                  )}

                  {a.program.coveredPlanTypes.length > 0 && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Covers:{" "}
                      {a.program.coveredPlanTypes.join(", ").toLowerCase()}
                      {a.program.allowedCategories.length > 0 &&
                        ` · in ${a.program.allowedCategories.join(", ")}`}
                    </p>
                  )}

                  {a.overageCount > 0 && (
                    <p className="mt-2 text-xs text-amber-700">
                      {a.overageCount.toLocaleString("en-IN")} overage{" "}
                      {a.overageCount === 1 ? "booking" : "bookings"} so far
                      this cycle
                      {overagePaise > 0 && (
                        <>
                          {" "}
                          ·{" "}
                          <span className="font-medium">
                            {formatCurrencyAmount(overagePaise, "INR")} to
                            settle
                          </span>{" "}
                          ·{" "}
                          <Link href="/dashboard/overage" className="underline">
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
                    <th className="px-4 py-2 font-medium whitespace-nowrap">
                      When
                    </th>
                    <th className="px-4 py-2 font-medium whitespace-nowrap">
                      Type
                    </th>
                    <th className="px-4 py-2 font-medium text-right whitespace-nowrap">
                      Consumed
                    </th>
                    <th className="px-4 py-2 font-medium text-right whitespace-nowrap">
                      Price
                    </th>
                    <th className="px-4 py-2 font-medium whitespace-nowrap">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const hasCreditPool = assignments.some(
                      (a) => a.program.type === "CREDIT_POOL",
                    );
                    const hasLicensedSeat = assignments.some(
                      (a) => a.program.type === "LICENSED_SEAT",
                    );
                    return utilizations.map((u) => {
                      const matchedAssignment = assignments.find(
                        (a) => a.id === u.programAssignmentId,
                      );
                      let isPoolUtilization = hasCreditPool && !hasLicensedSeat;
                      if (u.programSubType) {
                        isPoolUtilization = u.programSubType === "CREDIT_POOL";
                      } else if (matchedAssignment) {
                        isPoolUtilization =
                          matchedAssignment.program.type === "CREDIT_POOL";
                      }
                      let statusLabel = "Covered";
                      if (u.reversedAt) {
                        statusLabel = "Reversed";
                      } else if (u.wasOverage) {
                        statusLabel = "Overage";
                      }
                      return (
                        <tr key={u.id} className="border-t">
                          <td className="px-4 py-2 whitespace-nowrap">
                            {u.createdAt.toLocaleDateString("en-IN", {
                              timeZone: "Asia/Kolkata",
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })}
                          </td>
                          <td className="px-4 py-2 whitespace-nowrap">
                            {humanizeEnum(
                              u.payment.appointment?.appointmentType,
                            ) || "—"}
                          </td>
                          <td className="px-4 py-2 text-right whitespace-nowrap">
                            {isPoolUtilization
                              ? `${Math.round(u.priceAtBookingPaise / 100).toLocaleString("en-IN")} credits`
                              : u.engagementsConsumed}
                          </td>
                          <td className="px-4 py-2 text-right whitespace-nowrap">
                            {formatCurrencyAmount(u.priceAtBookingPaise, "INR")}
                          </td>
                          <td className="px-4 py-2 text-xs whitespace-nowrap">
                            {statusLabel}
                          </td>
                        </tr>
                      );
                    });
                  })()}
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
            <h2 className="text-lg font-medium mb-3">
              Other programs at this org
            </h2>
            <div className="space-y-2">
              {eligiblePrograms.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
                >
                  <div>
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {PROGRAM_TYPE_LABEL[p.type] ?? p.type} · you're not
                      assigned to this yet
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
        {orgCatalog.length > 0 && (
          <section id="org-catalog" className="space-y-3">
            <div>
              <h2 className="font-medium">Offered by {access.org.name}</h2>
              <p className="text-sm text-muted-foreground">
                Sessions and programmes this organisation runs itself.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {orgCatalog.map((plan) => (
                <Link
                  key={`${plan.planType}-${plan.id}`}
                  href={`/explore/programs/plans/${CATALOG_DETAIL_PATH[plan.planType]}/${plan.id}`}
                  className="block rounded-lg border bg-card p-4 hover:border-muted-foreground/30 hover:shadow-sm transition-all"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium text-sm">{plan.title}</p>
                    {plan.isMembersOnly && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 bg-muted text-muted-foreground">
                        Members only
                      </span>
                    )}
                  </div>
                  {(plan.subtitle ?? plan.description) && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                      {plan.subtitle ?? plan.description}
                    </p>
                  )}
                  <p className="text-xs font-semibold text-muted-foreground mt-2">
                    {formatCurrencyAmount(
                      Number(plan.price),
                      plan.priceCurrency,
                    )}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="pt-2 border-t text-xs text-muted-foreground space-y-2">
          {leaveError && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {leaveError}
            </p>
          )}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span>
              Need to leave {access.org.name}? Exiting releases any active
              program seats under this organization.
            </span>
            <details className="relative">
              <summary className="list-none cursor-pointer inline-flex items-center justify-center rounded-md text-xs font-medium h-8 px-3 border border-destructive/30 text-destructive hover:bg-destructive/10">
                Leave organization
              </summary>
              <div className="mt-2 rounded-lg border border-destructive/30 bg-card p-3 space-y-2 text-foreground max-w-sm">
                <p className="text-xs font-medium">
                  Leave {access.org.name} ({access.org.slug})?
                </p>
                <p className="text-xs text-muted-foreground">
                  Your membership ends immediately and active program seats are
                  released. Completed sessions and receipts remain on your
                  account.
                </p>
                <form
                  action={`/api/organizations/${orgId}/members/leave`}
                  method="post"
                >
                  <Button
                    type="submit"
                    size="sm"
                    variant="destructive"
                    className="h-7 text-xs"
                  >
                    Confirm leave organization
                  </Button>
                </form>
              </div>
            </details>
          </div>
        </div>
      </DashboardContent>
    </>
  );
}

// Plan family -> its public detail page, mirroring the public org page. A
// member evaluating an internal offering should read it before paying.
const CATALOG_DETAIL_PATH: Record<string, string> = {
  CONSULTATION: "consultations",
  SUBSCRIPTION: "subscriptions",
  WEBINAR: "webinars",
  CLASS: "classes",
};

function EmptyState({
  orgId,
  browseHref,
  browseLabel,
}: {
  orgId: string;
  browseHref: string;
  browseLabel: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="font-medium">No active programs yet</h2>
      <p className="text-sm text-muted-foreground mt-2">
        You&apos;re a member of this organisation, but no Program has been
        assigned to your account in the current cycle. Reach out to your org
        administrator to be added to a program.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button asChild size="sm">
          <Link href={browseHref}>{browseLabel}</Link>
        </Button>
        <Link
          href={`/dashboard/organization/${orgId}/home`}
          className="inline-flex text-sm text-primary underline"
        >
          Back to overview
        </Link>
      </div>
    </div>
  );
}
