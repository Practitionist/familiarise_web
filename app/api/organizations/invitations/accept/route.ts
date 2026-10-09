/**
 * POST /api/organizations/invitations/accept
 *
 * Accepts a pending `Invitation` by id and creates the typed `Membership`
 * row in the same transaction.
 *
 * Token race: two concurrent accepts from the same email could both pass
 * the pre-check. `updateMany WHERE status = pending` gives us an atomic
 * claim — only the first caller transitions the invitation to accepted,
 * the second sees count=0 and reports 409.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  buildSignupConsentArtifacts,
  checkConsent,
} from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { isOnboardingBlocked } from "@/lib/enterprise/org-status";
import { transitionMembership } from "@/lib/enterprise/transitions";
import {
  applyMembershipRoleEffects,
  recomputeConsultantIsIndependent,
} from "@/lib/api/organizations/membership-transitions";
import { notifyOrgInviteAccepted } from "@/lib/novu/org-workflows";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import { attemptOnboardingEmail, stageOrgWelcomeEmail } from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";

const AcceptBodySchema = z.object({
  invitationId: z.string().min(1),
  /** #1854 — the invitee agreed to the sign-up purposes on the accept page. */
  grantConsent: z.literal(true).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const raw = await req.json().catch(() => null);
  const parsed = AcceptBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { invitationId, grantConsent } = parsed.data;

  // Verify the invitation against the authenticated user's email before
  // doing anything mutative. Preventing accept-by-id-guessing means a
  // stolen URL from a user's inbox still can't be redeemed by someone
  // else's account.
  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    select: {
      id: true,
      organizationId: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
    },
  });
  if (!invitation) {
    return NextResponse.json(
      { error: "Invitation not found" },
      { status: 404 },
    );
  }
  // Closure-friendly non-null alias. TS doesn't carry the
  // null-narrowed flow type into the inner `runAcceptTx` function
  // declaration below; binding to a fresh const preserves the
  // narrowed type for closure reads.
  const inv = invitation;
  if (
    auth.session.user.emailVerified !== true ||
    inv.email.toLowerCase() !== auth.session.user.email.toLowerCase()
  ) {
    return NextResponse.json(
      { error: "This invitation is not addressed to you" },
      { status: 403 },
    );
  }
  if (inv.expiresAt.getTime() < Date.now()) {
    return NextResponse.json(
      { error: "Invitation has expired" },
      { status: 410 },
    );
  }

  const normalizedRole = inv.role;

  const userId = auth.session.user.id;
  // Same closure-friendly aliasing as `inv` above, for the staging inside runAcceptTx.
  const accepteeEmail = auth.session.user.email;
  const accepteeName = auth.session.user.name ?? accepteeEmail;

  // #701 — DPDP: the invitee must hold live core-processing consent before we
  // provision membership (which processes their PII on the org's behalf).
  // #1854 — an SSO-created account (or a withdrawal) has none; the accept
  // page shows the sign-up consent inline and re-posts with grantConsent,
  // which stamps the sign-up rows in the accept transaction.
  const needsConsent = !(await checkConsent({
    userId,
    purposeCode: PURPOSE_CODES.PRIMARY_PROCESSING,
  }));
  if (needsConsent && !grantConsent) {
    return NextResponse.json(
      {
        error: "Agree to how we process your data to join this organization.",
        code: "CONSENT_REQUIRED",
      },
      { status: 403 },
    );
  }

  // ENT-5: A second concurrent accept for the same (user, org) pair can
  // race past the in-tx existence check and hit P2002 on Membership's
  // (userId, organizationId) unique. Retry once: the second attempt will
  // see the row created by the winner and fall into the alreadyMember
  // idempotent branch. Bound the retry to keep this from masking real
  // bugs.
  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  let result: Awaited<ReturnType<typeof runAcceptTx>> | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await runAcceptTx();
      lastErr = undefined;
      break;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        attempt < MAX_ATTEMPTS
      ) {
        lastErr = err;
        continue;
      }
      lastErr = err;
      break;
    }
  }
  if (!result) {
    if (lastErr instanceof Error && "httpStatus" in lastErr) {
      const status =
        typeof lastErr.httpStatus === "number" ? lastErr.httpStatus : 500;
      return NextResponse.json({ error: lastErr.message }, { status });
    }
    throw lastErr ?? new Error("Invitation accept failed for unknown reason");
  }

  // The roster bell and the joiner's welcome were staged inside the accept
  // transaction (skipped when the accept was idempotent — nothing
  // newsworthy happened); only the vendor attempts run after the response.
  if (!result.alreadyMember) {
    const { stagedBells, stagedWelcome } = result;
    scheduleAfter(async () => {
      for (const row of stagedBells) await attemptTrigger(row);
      if (stagedWelcome) await attemptOnboardingEmail(stagedWelcome);
    }, "org.invitation.accept.post-commit");
  }

  // Client contract (app/organizations/invite/[token]/page.tsx): expects
  //   { organization: { id, name }, role?: string, alreadyMember?: boolean }
  // so it can redirect to /dashboard/organization/:id/home after accept.
  // Returning a bare `{ membership }` silently broke the redirect.
  return NextResponse.json(
    {
      organization: result.organization,
      role: result.membership.role,
      alreadyMember: result.alreadyMember,
      membership: result.membership,
    },
    { status: result.alreadyMember ? 200 : 201 },
  );

  async function runAcceptTx() {
    return prisma.$transaction(async (tx) => {
      // Atomic claim — only the first concurrent accept wins. Follow-up
      // retries get count=0 and fall into the 409 branch below.
      const claim = await tx.invitation.updateMany({
        where: { id: invitationId, status: "PENDING" },
        data: { status: "ACCEPTED", userId },
      });
      if (claim.count === 0) {
        throw Object.assign(new Error("Invitation is no longer pending"), {
          httpStatus: 409,
        });
      }
      // #1854 — consent commits with the join or rolls back with it.
      if (needsConsent) {
        await tx.consentArtifact.createMany({
          data: buildSignupConsentArtifacts(userId),
        });
      }

      // Re-fetch org status inside the tx so a SUSPENDED/DEACTIVATED org
      // can't be onboarded into via a stale invite link. The pre-check
      // outside the tx is not enough — an admin could suspend the org
      // mid-flight between the email click and the POST.
      const org = await tx.organization.findUnique({
        where: { id: inv.organizationId },
        select: {
          id: true,
          name: true,
          status: true,
          canSponsor: true,
          canHost: true,
        },
      });
      if (!org) {
        throw Object.assign(new Error("Organization no longer exists"), {
          httpStatus: 404,
        });
      }
      if (isOnboardingBlocked(org.status)) {
        throw Object.assign(
          new Error(
            `Organization is ${org.status.toLowerCase()}; cannot accept new members`,
          ),
          { httpStatus: 403 },
        );
      }
      if (normalizedRole === "EXPERT" && org.canHost === false) {
        throw Object.assign(
          new Error("Organization cannot host experts (canHost is false)"),
          { httpStatus: 403 },
        );
      }
      if (normalizedRole === "LEARNER" && org.canSponsor === false) {
        throw Object.assign(
          new Error(
            "Organization cannot sponsor learners (canSponsor is false)",
          ),
          { httpStatus: 403 },
        );
      }

      // The user may already hold a Membership here from SSO JIT.
      // A live row makes the accept idempotent, so the button is safe to
      // click twice. A REMOVED row, or a PENDING row from a pre-#1846 bulk
      // import, is what an invitation brings back: accepting is the only
      // door into ACTIVE for it (#1846 bucket C). An ERASED tombstone never
      // comes back.
      const existing = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId: inv.organizationId,
          },
        },
      });
      if (existing?.status === "ERASED") {
        throw Object.assign(
          new Error("This membership was erased and cannot be restored."),
          { httpStatus: 409 },
        );
      }
      const rejoining =
        existing?.status === "REMOVED" || existing?.status === "PENDING";
      if (existing && !rejoining) {
        return {
          membership: existing,
          organization: org,
          alreadyMember: true,
          stagedBells: [] as StagedTrigger[],
          stagedWelcome: null,
        };
      }

      // #729 §AC4/AC5 + #819 — who-is-acting identity rule. Accepting an
      // invitation is the USER'S OWN consenting action, so the lightweight
      // ConsulteeProfile may be lazy-created here (lib/auth.ts names
      // "invite-accept as LEARNER" as a sanctioned creation point — gating
      // it broke sponsored-employee onboarding). EXPERT stays strict: a
      // consultant identity carries domain/rates/verification/payout
      // prerequisites that no invite click can substitute for. SSO JIT keeps
      // its own lazy path; there is no admin direct-add any more (#1846).
      if (normalizedRole === "EXPERT") {
        const existingConsultant = await tx.consultantProfile.findUnique({
          where: { userId },
          select: { id: true },
        });
        if (!existingConsultant) {
          // Deliberately strict (not a lazy placeholder): an expert identity
          // carries domain/rates/verification/payout prerequisites no invite
          // click can substitute for. Emits the NOT_A_CONSULTANT code (not
          // free-form copy) so lib/labels/org-errors.ts humanizes it; the
          // invite page tells the user to finish consultant onboarding and
          // accept again from the emailed link.
          throw Object.assign(new Error("NOT_A_CONSULTANT"), {
            httpStatus: 400,
          });
        }
      }

      // Profile FK + payoutRecipient defaults are computed by the
      // shared helper (see lib/api/organizations/membership-transitions.ts).
      // LEARNER lazy-creates ConsulteeProfile (first consumer action).
      // Operator roles (OWNER/MAINTAINER/MANAGER/SUPPORT) leave both FKs
      // null. The EXPERT pre-check above means the helper never reaches
      // its EXPERT lazy-create branch from this surface. Multi-org experts
      // and learners stay first-class; see
      // docs/enterprise/60-scenarios-and-verdicts/01-scenarios-and-examples.md.
      const roleEffects = await applyMembershipRoleEffects(tx, {
        userId,
        role: normalizedRole,
      });

      const roleData = {
        role: normalizedRole,
        consulteeProfileId: roleEffects.consulteeProfileId,
        consultantProfileId: roleEffects.consultantProfileId,
        payoutRecipient: roleEffects.payoutRecipient,
      };
      const created = rejoining
        ? await rejoin(tx, existing.id, roleData)
        : await createMembership(tx, roleData);

      // #1867 — Accepting an organization invitation as a learner or operator
      // satisfies consumer onboarding so the user isn't redirected to /form
      // after joining their organization.
      if (
        normalizedRole !== "EXPERT" &&
        typeof tx.user?.update === "function"
      ) {
        await tx.user.update({
          where: { id: userId },
          data: { onboardingCompleted: true },
        });
      }

      await tx.orgAuditLog.create({
        data: {
          organizationId: inv.organizationId,
          actorMembershipId: created.id,
          targetMembershipId: created.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.INVITE_ACCEPTED,
          description: `User ${userId} accepted invitation to join as ${normalizedRole}`,
          details: {
            invitationId: inv.id,
            role: normalizedRole,
            ...(rejoining && { rejoinedFrom: existing.status }),
          },
        },
      });

      if (typeof tx.webhookEndpoint?.findMany === "function") {
        await dispatchWebhookEvent({
          prisma: tx,
          organizationId: inv.organizationId,
          eventType: "member.added",
          payload: {
            membershipId: created.id,
            userId,
            role: normalizedRole,
            source: "INVITATION",
            invitationId: inv.id,
          },
        });
      }

      // Staged HERE so the roster bell and the joiner's welcome commit with
      // the membership or roll back with it (review round 2 on #1700); the
      // roster is read through `tx` too. Attempted in after() by the caller.
      const origin = new URL(req.url).origin;
      const stagedBells = await notifyOrgInviteAccepted(
        inv.organizationId,
        {
          accepteeName,
          accepteeEmail,
          orgName: org.name,
          role: normalizedRole,
          dashboardUrl: `${origin}/dashboard/organization/${inv.organizationId}/members`,
        },
        { tx },
      );
      const stagedWelcome = await stageOrgWelcomeEmail(
        {
          userId,
          membershipId: created.id,
          orgName: org.name,
          role: normalizedRole,
          dashboardUrl: `${origin}/dashboard/organization/${inv.organizationId}/home`,
        },
        tx,
      );

      return {
        membership: created,
        organization: org,
        alreadyMember: false,
        stagedBells,
        stagedWelcome,
      };
    });
  }

  type RoleData = {
    role: typeof normalizedRole;
    consulteeProfileId: string | null;
    consultantProfileId: string | null;
    payoutRecipient: "SELF" | "ORGANIZATION";
  };

  /** A first-time joiner. */
  async function createMembership(tx: Tx, roleData: RoleData) {
    return tx.membership.create({
      data: {
        userId,
        organizationId: inv.organizationId,
        status: "ACTIVE",
        ...roleData,
      },
    });
  }

  /**
   * A removed member invited back (or a legacy PENDING import row) keeps the
   * same Membership row, so ProgramAssignment and audit FKs stay intact. The
   * invitation's role applies: "remove, then re-invite with the new role" is
   * exactly how a LEARNER becomes an EXPERT. The CAS refuses a row that
   * changed underneath (for example an erasure landing first).
   */
  async function rejoin(tx: Tx, membershipId: string, roleData: RoleData) {
    await transitionMembership(tx, {
      where: { id: membershipId, organizationId: inv.organizationId },
      to: "ACTIVE",
      data: roleData,
    });
    const rejoined = await tx.membership.findUniqueOrThrow({
      where: { id: membershipId },
    });
    if (rejoined.role === "EXPERT" && rejoined.consultantProfileId) {
      await recomputeConsultantIsIndependent(tx, rejoined.consultantProfileId);
    }
    return rejoined;
  }
}
