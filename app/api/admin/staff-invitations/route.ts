import { z } from "zod";
import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";

import prisma from "@/lib/prisma";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { applyRateLimit } from "@/lib/rate-limit";
import {
  accountKey,
  staffInviteCreateLimiter,
} from "@/lib/rate-limit/policies";
import { attemptStagedEmail } from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import {
  INVITABLE_STAFF_ROLES,
  STAFF_INVITATION_TTL_MS,
  mintStaffInvitationToken,
  hashStaffInvitationToken,
  normalizeStaffEmail,
  stageStaffInvitationEmail,
  STAFF_INVITATION_EMAIL_BUDGET_MS,
} from "@/lib/auth/staff-invitations";

/**
 * #1927 — the door that mints a platform operator.
 *
 * The only `role: STAFF` write site in the app (the second, `PUT
 * /api/user/staff/{id}`, writes no role). Reached from the Team page; before
 * this existed, an admin onboarding a colleague had exactly one option,
 * `POST /api/user/staff` with a password the ADMIN chose and transmitted in
 * plaintext. That route is now a refusal pointing here.
 *
 * ## The transaction boundary
 *
 * `withOpsAction`'s `mode: "tx"` puts three rows in ONE transaction: the
 * invitation, the `FailedEmail` outbox row, and the `OpsActionLog` audit row.
 * That is not tidiness.
 *  - A rolled-back invite must leave no outbox row, or the relay mails a link
 *    to an invitation that does not exist — a live credential in a stranger's
 *    inbox, unrevokable because nothing exists to revoke.
 *  - A committed invite must have an audit row, or "who granted this person
 *    platform access" is unanswerable, and `users.moderate` is the grant that
 *    can suspend a colleague the next morning.
 *  - The audit row carries the reason, so the Team page and the ops log agree
 *    without a second write.
 *
 * The vendor call is the one thing outside it, in `scheduleAfter` — see the
 * two-phase contract in lib/email/deliver.ts. It must not join the
 * transaction: Resend is a network call, the Netlify function is 60s, and
 * `PG_POOL_MAX=1` means a transaction holding the pool's only connection while
 * awaiting HTTP is how an invite times out with the row already written and
 * the operator none the wiser.
 *
 * ## No domain check
 *
 * There is deliberately nothing here that inspects the domain of `email`, and
 * there must never be. Staff addresses are a mix of personal and company mail;
 * the reasoning is in the model doc in prisma/schema.prisma. If you came here
 * to add an allowlist, read that first.
 */
export const POST = withOpsAction(
  // Admin-only per lib/auth/backoffice-permissions.ts: minting a privileged
  // account is the same class of act as taking one away.
  "users.moderate",
  "staff.invite.create",
  {
    email: z.string().trim().email().max(320),
    /** The role to grant. ADMIN is reachable here on purpose — see below. */
    role: z.enum(["STAFF", "ADMIN"]).default("STAFF"),
    /** Re-send to an address that already holds a PENDING invite. */
    resend: z.boolean().default(false),
  },
  {
    mode: "tx",
    run: async (tx, { body, actor }) => {
      const email = normalizeStaffEmail(body.email);

      // Per-admin budget, not a shared one. Keyed on `accountKey` so the Redis
      // key is a digest — an address list must not live in Upstash (the same
      // reason the policy table hashes, and the reason Sentry holds
      // sendDefaultPii: false).
      if (
        await applyRateLimit(
          staffInviteCreateLimiter,
          await accountKey(actor.userId),
        )
      ) {
        throw new OpsRefusal(
          "RATE_LIMITED",
          "Too many invitations created in the last hour — wait and try again.",
          429,
        );
      }

      // An address that already holds an account cannot be invited: the
      // invitation's whole contract is "you set your own password", and there
      // is nothing left to set. Changing an existing operator's role is the
      // moderation surface's job, not this one.
      const existingUser = await tx.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existingUser) {
        throw new OpsRefusal(
          "ALREADY_EXISTS",
          "That address already has a Familiarise account — change their role from the Team page instead of re-inviting them.",
          409,
        );
      }

      const pending = await tx.staffInvitation.findFirst({
        where: { email, status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });

      // Read the inviter's name ON THE TRANSACTION, not on `prisma`. Netlify
      // runs PG_POOL_MAX=1 (#1421), so a query on the global client while this
      // transaction holds the pool's only connection waits for a second
      // connection that can never arrive and dies at the 3s connect timeout.
      // A failed read costs the email its "X invited you" line, not the
      // invite, so the fallback is the template's own default.
      const inviter = await tx.user.findUnique({
        where: { id: actor.userId },
        select: { name: true },
      });
      const inviterName =
        inviter?.name?.trim() || "A Familiarise administrator";

      if (pending) {
        if (!body.resend) {
          throw new OpsRefusal(
            "INVITE_EXISTS",
            "There is already a pending invitation for that address. Send a resend if they did not get it.",
            409,
          );
        }
        // A resend RE-MINTS the token. That is the point: once the mail is
        // lost, the old link may be sitting in a wrong inbox, and rotating
        // the token means the forwarded copy stops working the moment the
        // real one is re-sent. `sentCount` is both the audit trail and the
        // reason a resend is not free.
        const rawToken = mintStaffInvitationToken();
        const expiresAt = new Date(Date.now() + STAFF_INVITATION_TTL_MS);
        await tx.staffInvitation.update({
          where: { id: pending.id },
          data: {
            tokenHash: hashStaffInvitationToken(rawToken),
            expiresAt,
            role: body.role,
            sentCount: { increment: 1 },
            lastSentAt: new Date(),
          },
        });
        const staged = await stageStaffInvitationEmail(
          { email, inviterName, role: body.role, rawToken, expiresAt },
          tx,
        );
        // `scheduleAfter` is CALLED inside the transaction but RUNS after the
        // response, which `withOpsAction` only produces once its transaction
        // has committed. So the vendor call cannot observe an uncommitted row
        // — the thing that would mail a link to an invitation that then rolls
        // back. `withOpsAction` has no post-commit hook to schedule from (its
        // result is serialized straight into the response body), which is why
        // this is here rather than in the route body.
        scheduleAfter(() =>
          attemptStagedEmail(staged, STAFF_INVITATION_EMAIL_BUDGET_MS),
        );
        return {
          target: { kind: "StaffInvitation", id: pending.id },
          correlationId: `staff-invitation:${pending.id}`,
          after: {
            email,
            role: body.role,
            resent: true,
            sentCount: pending.sentCount + 1,
          },
          response: {
            invitationId: pending.id,
            email,
            role: body.role,
            expiresAt: expiresAt.toISOString(),
            resent: true,
          },
        };
      }

      const rawToken = mintStaffInvitationToken();
      const expiresAt = new Date(Date.now() + STAFF_INVITATION_TTL_MS);
      // A P2002 here is the sidecar partial unique index
      // (`staff_invitations_email_pending_key`) doing its job on a race the
      // findFirst above could not see. Folded into the same 409 so the client
      // has one shape to handle.
      let created;
      try {
        created = await tx.staffInvitation.create({
          data: {
            email,
            role: body.role,
            tokenHash: hashStaffInvitationToken(rawToken),
            expiresAt,
            sentCount: 1,
            lastSentAt: new Date(),
            invitedByUserId: actor.userId,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new OpsRefusal(
            "INVITE_EXISTS",
            "There is already a pending invitation for that address.",
            409,
          );
        }
        throw error;
      }

      const staged = await stageStaffInvitationEmail(
        { email, inviterName, role: body.role, rawToken, expiresAt },
        tx,
      );
      scheduleAfter(() =>
        attemptStagedEmail(staged, STAFF_INVITATION_EMAIL_BUDGET_MS),
      );

      return {
        target: { kind: "StaffInvitation", id: created.id },
        correlationId: `staff-invitation:${created.id}`,
        after: {
          email,
          role: body.role,
          resent: false,
          expiresAt: expiresAt.toISOString(),
        },
        response: {
          invitationId: created.id,
          email,
          role: body.role,
          expiresAt: expiresAt.toISOString(),
          resent: false,
          // Deliberately NOT the token. It exists in the mail and nowhere
          // else; a create response carrying it would put a privileged
          // credential into a browser history, a proxy log and a Sentry
          // breadcrumb. An operator with no mail access uses
          // `scripts/bootstrap-admin.ts --print` instead, which is a shell
          // they control.
        },
      };
    },
  },
);

/**
 * GET /api/admin/staff-invitations — the operator roster and the invite
 * history, for the Team page.
 *
 * Hand-written rather than `withOpsAction`, because that wrapper parses a body
 * and requires a `reason`: a page load has neither, and forcing one would mean
 * an audit row per render. It is gated on the same surface family, so an
 * operator without `team.read` gets the same 403 the page guard gives them,
 * and it inherits the 2FA precondition `requireBackofficeSurface` applies.
 */
export async function GET(_req: NextRequest) {
  const auth = await requireBackofficeSurface("team.read");
  if (auth.error) return auth.error;

  const now = new Date();
  const operators = await prisma.user.findMany({
    where: { role: { in: [...INVITABLE_STAFF_ROLES] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      banned: true,
      banExpires: true,
      twoFactorEnabled: true,
      onboardingCompleted: true,
      createdAt: true,
      staffProfile: {
        select: { id: true, department: true, position: true },
      },
      adminProfile: { select: { id: true } },
    },
  });

  // One query for both "active sessions" and "last seen", rather than a
  // per-row count (N+1 across the roster) or a nested `take` Prisma does not
  // support. Rows are ordered newest-first so the FIRST hit per user is their
  // last seen; the count is the same set, filtered to unexpired rows, which is
  // why "active" is honest — a device that signed out three weeks ago is not
  // an active session and must not be counted as one.
  const sessions = operators.length
    ? await prisma.session.findMany({
        where: {
          userId: { in: operators.map((o) => o.id) },
          expiresAt: { gt: now },
        },
        orderBy: { updatedAt: "desc" },
        select: { userId: true, updatedAt: true },
      })
    : [];

  const lastSeenByUser = new Map<string, string>();
  const activeByUser = new Map<string, number>();
  for (const row of sessions) {
    activeByUser.set(row.userId, (activeByUser.get(row.userId) ?? 0) + 1);
    if (!lastSeenByUser.has(row.userId)) {
      // BetterAuth's day-granular refresh stamp. Never a "currently
      // active" claim — see lib/auth/session-select.ts.
      lastSeenByUser.set(row.userId, row.updatedAt.toISOString());
    }
  }

  const invitations = await prisma.staffInvitation.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      sentCount: true,
      lastSentAt: true,
      createdAt: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      acceptedUserId: true,
      invitedBy: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json({
    operators: operators.map((operator) => ({
      ...operator,
      lastSeenAt: lastSeenByUser.get(operator.id) ?? null,
      activeSessions: activeByUser.get(operator.id) ?? 0,
    })),
    invitations,
  });
}
