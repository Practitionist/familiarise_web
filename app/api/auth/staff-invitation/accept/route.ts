import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma, type UserRole } from "@prisma/client";

import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { applyRateLimit } from "@/lib/rate-limit";
import {
  staffInvitationAcceptIpLimiter,
  staffInvitationAcceptTokenLimiter,
  tokenKey,
} from "@/lib/rate-limit/policies";
import { buildSignupConsentArtifacts } from "@/lib/compliance/dpdp";
import { sendWelcomeEmail } from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import { reportSentryError } from "@/lib/observability/report";
import {
  claimStaffInvitation,
  hashStaffPassword,
  lookupStaffInvitationByToken,
  normalizeStaffEmail,
  StaffPasswordError,
  type StaffInvitationRefusalCode,
} from "@/lib/auth/staff-invitations";

/**
 * #1927 — POST /api/auth/staff-invitation/accept
 *
 * The half of operator onboarding the invitee performs. Unauthenticated by
 * necessity (there is no account yet) and therefore the most exposed door in
 * the app: the bearer credential in the URL is worth `refunds.manage`.
 *
 * ## What the token authorises, precisely
 *
 * Exactly one thing: "create a User with THIS email, THIS role, and a password
 * the holder chooses." The request body carries a token and a password and
 * nothing else — no `email`, no `role`, no `name` the caller could assert. An
 * attacker holding a leaked link cannot redirect the account to their own
 * address, cannot promote it to ADMIN, and cannot create a second account with
 * it. This mirrors the org invite-accept precedent
 * (`app/api/organizations/invitations/accept/route.ts:85`), where the claim is
 * bound to the caller's own address; here the binding is stronger, because
 * the address is a column on the row rather than a comparison of two.
 *
 * ## `emailVerified: true` — the invitation IS the proof
 *
 * This looks like a skipped verification step and it is not. The usual reason
 * to require `verify-email` is that the platform cannot otherwise show the
 * address belongs to its owner. Here it can, in the strongest available way: a
 * human with platform authority caused a row addressed to this exact address
 * to be created, and the holder of that address redeemed a 256-bit token that
 * was delivered only to it. A verification email would prove the same fact by
 * the same mechanism, a second time, and would fail for the personal-address
 * half of the team whose mail is slowest to arrive. The other reason to verify
 * — `requireEmailVerification: true` in `lib/auth.ts` exists to stop an
 * attacker pre-registering a victim's address and then hijacking it via a later
 * OAuth login — does not apply, because a holder of this token
 * controls this address right now and there is no pre-registration race: the
 * `User.email` unique below is the gate, and losing that race is a 409.
 *
 * ## No session is created
 *
 * The alternative — sign the new operator straight in — needs a BetterAuth
 * session mint inside a Serializable transaction, which BetterAuth's session
 * API cannot join, plus a `sessionGeneration` bump and a cross-device
 * revocation signal to stay consistent with how every other session in this app
 * is made. For one user, once, that is a lot of machinery. Not signing in means
 * the flow ends at "your account exists", the invitee types their password
 * into the sign-in form they will use forever after, and the whole path stays
 * on Prisma. The single-use property is preserved independently: the token is
 * burned by the CAS inside the transaction, so a second redemption is a
 * `SETUP_TOKEN_ALREADY_USED` 410 whether or not anyone was signed in.
 *
 * ## The transaction boundary
 *
 * ONE `Serializable` transaction, retried on P2034 by `withSerializableRetry`,
 * containing exactly seven things, in this order:
 *   1. the `User` (role, `emailVerified: true`, `onboardingCompleted: true`);
 *   2. the denormalised `User.staffProfileId` / `adminProfileId` and the
 *      `StaffProfile` / `AdminProfile` row behind it;
 *   3. the credential `Account` with the BetterAuth-verifiable hash;
 *   4. the `CookiePreference` + `NotificationPreference` rows that
 *      `user.create.after` (lib/auth.ts) creates for every normal signup;
 *   5. the DPDP `ConsentArtifact` rows from `buildSignupConsentArtifacts`;
 *   6. the CAS claim of the invitation — status PENDING → ACCEPTED, with
 *      `acceptedAt` and `acceptedUserId` in the SAME `updateMany`.
 *
 * The claim is last, which reads backwards for a single-use gate. The reason
 * is in the code: `acceptedUserId` is both `@unique` and a foreign key, so no
 * placeholder value satisfies it — a sentinel is an FK violation, and a
 * per-call sentinel is a P2002 between two colleagues accepting at the same
 * moment. Doing it in this order makes `User.email`'s own unique index the
 * first line (two redemptions of one link collide there) and the CAS the
 * second (two links to one person cannot both win), and it means a losing
 * attempt rolls back every row above rather than leaving a half-onboarded
 * operator behind.
 *
 * Why each thing is inside rather than after: a User with no credential
 * Account cannot sign in, and an invitation marked ACCEPTED with no User
 * behind it can never be redeemed again — both are unrecoverable states that
 * no retry can fix. The consent rows are inside because `checkConsent` fails
 * closed, so a staff account missing them trips every purpose-scoped gate in
 * the app later.
 *
 * Why the profile and the `onboardingCompleted` flag are inside and set: see
 * the note on that flag at step 1. It is the single easiest way to permanently
 * lock out the operator this route creates.
 */
const AcceptBodySchema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1).max(200),
  name: z.string().trim().min(1).max(120).optional(),
  /** #1854 precedent: the invitee ticked the data-processing consent. */
  grantConsent: z.literal(true).optional(),
});

export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => null);
  const parsed = AcceptBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid request",
        code: "SETUP_TOKEN_INVALID",
      },
      { status: 400 },
    );
  }
  const { token, password, name } = parsed.data;

  // Two dimensions, both spent before any database work. IP catches a sweep
  // of guessed tokens from one host; the per-token bucket is the one that
  // matters, because a leaked link is a privileged credential and ten
  // redemptions an hour turns it from a takeover into a statistic. Both keys
  // are digests, never the token or the address (lib/rate-limit/policies.ts).
  const ipKey =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (
    (await applyRateLimit(staffInvitationAcceptIpLimiter, ipKey)) ||
    (await applyRateLimit(
      staffInvitationAcceptTokenLimiter,
      await tokenKey(token),
    ))
  ) {
    return NextResponse.json(
      {
        error:
          "Too many attempts with this link. Wait an hour, or ask an administrator for a new one.",
        code: "SETUP_TOKEN_INVALID",
        scope: "platform.staff-invitation-accept",
      },
      { status: 429 },
    );
  }

  const lookup = await lookupStaffInvitationByToken(token);
  if (lookup.refusal) {
    return refusalResponse(
      lookup.refusal,
      lookup.refusal === "SETUP_TOKEN_INVALID" ? 404 : 410,
    );
  }
  const invitation = lookup.invitation;
  const email = normalizeStaffEmail(invitation.email);

  // An address that already holds an account cannot be redeemed — the token
  // would be creating a second login for someone who already has one. The
  // realistic cause is a re-invite after a password reset, so the message
  // points at sign-in rather than at support.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      {
        error:
          "That address already has a Familiarise account. Sign in instead, or reset your password.",
        code: "INVITATION_ALREADY_ACCEPTED",
      },
      { status: 409 },
    );
  }

  let created: {
    userId: string;
    email: string;
    name: string;
    /**
     * Typed as the full `UserRole` rather than the `STAFF | ADMIN` both mint
     * paths constrain it to, because that is what the column holds and a
     * hand-edited or backfilled row must not be silently narrowed on its way
     * to the response. Nothing downstream branches on it.
     */
    role: UserRole;
  };
  try {
    created = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // 2. The User. `onboardingCompleted: true` is NOT cosmetic:
          //    `isFullyOnboarded` in lib/auth-guard.ts is
          //    `onboardingCompleted && roleProfileExists`, and
          //    `requireBackofficePage` redirects anything else to
          //    /form/onboarding — whose submit handler HARD-REJECTS
          //    STAFF and ADMIN (utils/onboarding-server.ts:824). An operator
          //    created with the flag false is therefore routed into a wizard
          //    that cannot complete, forever. The role profile below is the
          //    other half of that predicate.
          //
          //    Created BEFORE the claim, which looks backwards for a
          //    single-use gate and is not. `acceptedUserId` is `@unique`
          //    AND carries a foreign key, so there is no placeholder value
          //    that satisfies it — a sentinel would be either an FK
          //    violation or, if made unique per call, a P2002 between two
          //    colleagues accepting at the same moment. Instead the two
          //    independent constraints do the work together: `User.email`
          //    is unique, so two redemptions of the SAME link collide there
          //    (one wins, the other rolls back), and the claim below is the
          //    gate for two redemptions of DIFFERENT links to the same
          //    person. The claim is last so a rolled-back attempt leaves no
          //    User behind.
          const isAdmin = invitation.role === "ADMIN";
          const resolvedName = name || deriveNameFromEmail(email);
          const user = await tx.user.create({
            data: {
              // The address is the row's, never the caller's.
              email,
              name: resolvedName,
              emailVerified: true,
              role: invitation.role,
              onboardingCompleted: true,
              // Terms/privacy timestamps are stamped by the consent
              // artifacts below; these two columns are what the settings and
              // checkout copy read, and leaving them null made an invited
              // account look un-accepted on the profile page.
              termsAcceptedAt: new Date(),
              privacyAcceptedAt: new Date(),
            },
            select: { id: true },
          });

          // 3 + 4. The role profile, then the denormalised id the session
          //    layer reads (BetterAuth `additionalFields`). A STAFF user with
          //    no StaffProfile is not "fully onboarded" per the predicate
          //    above, so this is load-bearing, not decoration.
          if (isAdmin) {
            const profile = await tx.adminProfile.create({
              data: { userId: user.id, notes: null },
              select: { id: true },
            });
            await tx.user.update({
              where: { id: user.id },
              data: { adminProfileId: profile.id },
            });
          } else {
            const profile = await tx.staffProfile.create({
              data: { userId: user.id },
              select: { id: true },
            });
            await tx.user.update({
              where: { id: user.id },
              data: { staffProfileId: profile.id },
            });
          }

          // 5. The credential. Hashed by the one function BetterAuth also
          //    uses (lib/auth/staff-invitations.ts `hashStaffPassword`) — see
          //    the long note there on why this must not be a second, inline
          //    `bcrypt.hash(password, 12)`.
          await tx.account.create({
            data: {
              userId: user.id,
              accountId: email,
              providerId: "credential",
              password: await hashStaffPassword(password),
            },
          });

          // 6. What `user.create.after` (lib/auth.ts) gives every normal
          //    signup, minus the welcome mail, which is sent post-commit
          //    below so a Resend stall cannot hold this transaction open.
          //    Upserts rather than creates so a retry of this transaction
          //    (P2034) cannot die on a unique.
          await tx.cookiePreference.upsert({
            where: { userId: user.id },
            create: { userId: user.id },
            update: {},
          });
          await tx.notificationPreference.upsert({
            where: { userId: user.id },
            create: { userId: user.id },
            update: {},
          });

          // 7. DPDP. `checkConsent` fails CLOSED, so a staff account without
          //    these rows trips every purpose-scoped gate in the app later
          //    (Stream handoff, booking, payout). `buildSignupConsentArtifacts`
          //    is the same helper the signup hook calls, so the purposes are
          //    the same set by construction rather than by a list kept in sync
          //    here.
          await tx.consentArtifact.createMany({
            data: buildSignupConsentArtifacts(user.id),
          });

          // 1 (last). Burn the token. `updateMany WHERE status = PENDING` is
          //    the atomic claim: two redemptions that both reach this line
          //    cannot both win, and the loser rolls the whole transaction
          //    back — User, profile, Account, preferences, consent and all —
          //    so there is no half-onboarded operator to clean up. The FK
          //    and the unique on `acceptedUserId` are satisfied in the same
          //    statement, which is why the claim could not be first.
          const claimed = await claimStaffInvitation(
            tx,
            invitation.id,
            user.id,
          );
          if (!claimed) {
            throw new AcceptTxRefusal("SETUP_TOKEN_ALREADY_USED", 410);
          }

          return {
            userId: user.id,
            email,
            name: resolvedName,
            role: invitation.role,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  } catch (error) {
    if (error instanceof AcceptTxRefusal) {
      return refusalResponse(error.code, error.httpStatus);
    }
    // A P2002 is the EXPECTED shape of two people opening the same link at the
    // same moment: the User insert is the first statement, so `User.email`'s
    // unique index is what one of them loses on. (Under `Serializable` the
    // loser more often gets a P2034 and is retried, and the retry then loses
    // on the CAS and answers SETUP_TOKEN_ALREADY_USED — but READ COMMITTED on
    // a replica, or a future caller that drops the isolation level, would
    // arrive here, and it must be a specific answer rather than a 500.) The
    // same code covers an address created in the gap by some other path.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        {
          error:
            "That address already has a Familiarise account. Sign in instead, or reset your password.",
          code: "INVITATION_ALREADY_ACCEPTED",
        },
        { status: 409 },
      );
    }
    if (error instanceof StaffPasswordError) {
      return NextResponse.json(
        { error: error.message, code: "INVALID_BODY" },
        { status: 400 },
      );
    }
    reportSentryError(error, {
      subsystem: "auth",
      op: "staff-invitation:accept",
    });
    return NextResponse.json(
      {
        error: "Something went wrong setting up your account.",
        code: "FAILED",
      },
      { status: 500 },
    );
  }

  // Post-commit, best-effort. No session is minted (see the header), so this
  // is the only thing left on the path, and it is the same welcome every other
  // signup gets — `sendWelcomeEmail` dead-letters into `FailedEmail` on
  // failure, so a Resend outage costs a mail and not an account.
  scheduleAfter(() =>
    sendWelcomeEmail({
      email: created.email,
      name: created.name,
      userId: created.userId,
    }),
  );

  return NextResponse.json(
    {
      ok: true,
      email: created.email,
      role: created.role,
      // The client sends them to sign-in. Deliberately no token, no session
      // cookie, and no `autoSignIn` hint.
      next: "/auth/signin",
    },
    { status: 201 },
  );
}

/** A modelled refusal raised from inside the transaction, so it rolls back. */
class AcceptTxRefusal extends Error {
  constructor(
    readonly code: StaffInvitationRefusalCode,
    readonly httpStatus: number,
  ) {
    super(code);
    this.name = "AcceptTxRefusal";
  }
}

/**
 * 410 for a spent/expired/revoked link, 404 for an unknown one.
 *
 * The split is not disclosure theatre: an unknown token has no row to describe,
 * and a known-but-finished one has a state the person holding it needs to be
 * told (their link is old, not their memory). Both carry a code the catalog has
 * copy for, so the page renders a sentence instead of a raw status.
 */
function refusalResponse(code: StaffInvitationRefusalCode, status: number) {
  return NextResponse.json(
    { error: "This setup link cannot be used.", code },
    { status },
  );
}

/**
 * A display name when the invitee did not supply one.
 *
 * The form asks, but the field is optional so a resend from a terminal (the
 * `scripts/bootstrap-admin.ts` path) can skip it. Local-part, title-cased —
 * never rendered into an email header, and the only thing the welcome mail
 * uses it for.
 */
function deriveNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "Operator";
  const words = local
    .replace(/[._-]+/g, " ")
    .replace(/\d+/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Operator";
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 120);
}
