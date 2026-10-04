/**
 * GET  /api/organizations/[orgId]/invitations
 * POST /api/organizations/[orgId]/invitations
 *
 * Backed by the app's own `Invitation` table (BetterAuth's organization
 * plugin is not mounted). The typed `Membership` row is created at accept
 * time (see /api/organizations/invitations/accept/route.ts).
 *
 * EXPERT requires canHost=true and LEARNER canSponsor=true (checked below);
 * SUPPORT is invitable like the other operator roles (#1527). The role list
 * lives in the Zod schema.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { HostInvitableMemberRoleSchema } from "@/lib/labels/org-labels";
import { InvitationStatus, Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  DomainVerificationRequiredError,
  UNVERIFIED_ORG_SEAT_CAP,
} from "@/lib/enterprise/governance";
import { issueInvitation } from "@/lib/enterprise/invitations";
import { MembershipGuardError } from "@/lib/enterprise/membership-guards";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import {
  attemptStagedEmail,
  EMAIL_BUDGET_MS,
  type StagedSend,
} from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import { applyRateLimit, orgInviteLimiter } from "@/lib/rate-limit";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

// #817 — the canonical invitable set lives in org-labels; a local duplicate
// here drifted (BILLING_ADMIN went missing) so the route now imports it.
// EXPERT is gated by canHost below; SUPPORT stays owner-only (Settings).

const InviteBodySchema = z.object({
  email: z.string().email(),
  role: HostInvitableMemberRoleSchema,
  // Default expiry: 14 days. Overridable up to 30 to avoid long-lived
  // invite tokens sitting in inboxes indefinitely.
  expiresInDays: z.coerce.number().int().min(1).max(30).default(14),
});

const StatusFilterSchema = z.nativeEnum(InvitationStatus);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "invitations.manage",
  });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus ? StatusFilterSchema.safeParse(rawStatus) : null;

  const invitations = await prisma.invitation.findMany({
    where: {
      organizationId: orgId,
      ...(status?.success ? { status: status.data } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      inviterId: true,
    },
  });

  return NextResponse.json({ data: invitations });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Invitations require an operable org, but NOT a verified one:
  // #1132 follow-up — this route was hard-gated on ACTIVE, which made the
  // UNVERIFIED_ORG_SEAT_CAP grace (enforced in-tx below) unreachable dead
  // code. The creation wizard fires team invites seconds after creating a
  // PENDING_VERIFICATION org and every one of them 409'd ORG_NOT_VERIFIED,
  // poisoning the launch moment for every self-serve org. Pre-verification
  // orgs may now invite up to the seat cap; SUSPENDED / DEACTIVATED orgs
  // stay blocked by the explicit check here.
  const access = await requireOrgAccess(orgId, {
    permission: "invitations.manage",
    requireActive: true,
  });
  if (access.error) return access.error;
  // SUSPENDED-only: requireOrgAccess already answers 403 for DEACTIVATED
  // before this handler ever sees `access` (CR #1234 — the deactivated arm
  // here was unreachable dead code).
  if (access.org.status === "SUSPENDED") {
    return NextResponse.json(
      {
        error: "ORG_NOT_ACTIVE",
        message: "Invitations are paused while the organization is suspended.",
        status: access.org.status,
      },
      { status: 409 },
    );
  }

  // Per-org sliding-window cap: 20 invitations per hour. Keyed on orgId
  // (not IP) so a credential-stuffing attacker that rotates IPs still
  // trips the limit. Prevents audit-log and Novu notification spam.
  const rateLimited = await applyRateLimit(orgInviteLimiter, orgId);
  if (rateLimited) return rateLimited;

  const raw = await req.json().catch(() => null);
  const parsed = InviteBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { role, expiresInDays } = parsed.data;
  // Normalize before any read or write: the accept flow compares lowercased
  // emails and the sidecar unique index dedups on lower(email), so a
  // mixed-case duplicate must not slip past the pre-check or the insert.
  const email = parsed.data.email.trim().toLowerCase();

  // EXPERT is only valid for orgs that host consultants. Sponsor-only
  // orgs have no payout account / RateCard / settlement path for an
  // EXPERT's earnings, so the role is rejected even if a stale
  // dashboard payload smuggles it through. Returning the typed code
  // lets humanizeOrgError surface a precise message.
  if (role === "EXPERT" && !access.org.canHost) {
    return NextResponse.json(
      {
        error: "EXPERT can only be assigned on host-capable organizations",
        code: "EXPERT_REQUIRES_CANHOST",
      },
      { status: 400 },
    );
  }

  // LEARNER mirrors EXPERT: host-only orgs have no Contract / Program /
  // Wallet to fund the learner's sessions, so the role is rejected at
  // the invite boundary. Same defence-in-depth pattern.
  if (role === "LEARNER" && !access.org.canSponsor) {
    return NextResponse.json(
      {
        error: "LEARNER can only be assigned on sponsor-capable organizations",
        code: "LEARNER_REQUIRES_CANSPONSOR",
      },
      { status: 400 },
    );
  }

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  // De-dupe active invitations by (orgId, email): a retry refreshes the
  // pending invitation instead of minting a second token. The helper also
  // refuses an existing member and applies the unverified-org seat cap and
  // the OWNER-only roles (#1851 decision 6). Serializable because two
  // concurrent POSTs would otherwise both read "no pending row" and insert;
  // the partial unique index (#747/#685) is the backstop, surfaced as P2002.
  let wasExisting = false;
  let invitation;
  // Staged inside the transaction below: the notice rows commit with the
  // invitation or roll back with it (review round 2 on #1700).
  let stagedBells: StagedTrigger[] = [];
  let stagedEmail: StagedSend | null = null;
  const origin = new URL(req.url).origin;
  try {
    // #1132 follow-up — P2034 aborts retry via the house helper.
    invitation = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const issued = await issueInvitation(tx, {
            orgId,
            orgName: access.org.name,
            email,
            role,
            expiresAt,
            inviter: {
              userId: access.session.user.id,
              name: access.session.user.name ?? access.session.user.email,
              membershipId: access.member.id,
              role: access.member.role,
            },
            origin,
          });
          wasExisting = issued.wasExisting;
          stagedBells = issued.stagedBells;
          stagedEmail = issued.stagedEmail;
          return issued.invitation;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (err) {
    if (err instanceof MembershipGuardError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.httpStatus },
      );
    }
    if (err instanceof DomainVerificationRequiredError) {
      return NextResponse.json(
        {
          error: `Verify a domain to invite more than ${UNVERIFIED_ORG_SEAT_CAP} members`,
          code: err.code,
        },
        { status: err.httpStatus },
      );
    }
    // P2002 from a future partial unique index would land here; today
    // we hit it only if the Serializable retry budget exhausts. Convert
    // to 409 so the client can simply re-render the existing invitation.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error: "Pending invitation already exists for this email",
          code: "INVITATION_EXISTS",
        },
        { status: 409 },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "organizations" } },
    );
    throw err;
  }

  // Vendor attempts after the response; the rows above are the durable part.
  scheduleAfter(async () => {
    for (const row of stagedBells) await attemptTrigger(row);
    await attemptStagedEmail(stagedEmail, EMAIL_BUDGET_MS.AUTH);
  }, "org.invitation.send");

  return NextResponse.json({ invitation }, { status: wasExisting ? 200 : 201 });
}
