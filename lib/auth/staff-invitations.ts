/**
 * #1927 — platform operator (STAFF / ADMIN) onboarding: token minting,
 * verification, and the password hash the sign-in path will verify.
 *
 * Three things live here and nothing else does, because each of them has
 * exactly one correct implementation and having two is how a takeover
 * happens:
 *
 *  1. The invitation token's lifecycle (mint → hash → look up → CAS-claim).
 *  2. {@link hashStaffPassword} — the ONE function that produces a
 *     BetterAuth-verifiable credential hash outside BetterAuth.
 *  3. The email staging helper, so the row and its mail commit together.
 *
 * ## Why the domain is never checked here
 *
 * The obvious implementation of "invite a staff member" is an allowlist of
 * `@familiarisenow.com`. It is wrong here and the wrongness is a product
 * fact, not a technical one: staff addresses are a mix of personal
 * `@gmail.com` and `@familiarisenow.com`. A domain check would lock out half
 * the team, and worse, it would look like a control while being only a
 * convention — the actual authorisation is "an existing ADMIN minted this row
 * and the holder of this address redeemed the token", and nothing about the
 * address's right-hand side adds to that. So there is no domain branch in this
 * file, there must never be one, and the checks a future maintainer will be
 * tempted to add (`endsWith("@familiarisenow.com")`, a `trustedDomains` env
 * var, a JIT-by-domain auto-provision) are all refusals of the same wrong
 * idea. Revocation is per-USER for the same reason: see the model doc in
 * prisma/schema.prisma.
 *
 * Domain-enforced SSO still exists, for CUSTOMERS, in
 * `SsoProvider` / `lib/sso/**`. It is a different feature and this file must
 * not grow a line of it.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcrypt";
import type { ReactElement } from "react";
import type { Prisma, StaffInvitationStatus, UserRole } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { renderEmail } from "@/lib/email/render";
import { stage, type RenderedEmail, type StagedEmail } from "@/lib/email";
import { EMAIL_BUDGET_MS, SENDERS } from "@/lib/email/config";
import { StaffInvitationEmail } from "@/emails/staff/StaffInvitationEmail";
import { getAppUrl } from "@/lib/url";
import { reportSentryError } from "@/lib/observability/report";

/* -------------------------------------------------------------------------- */
/* Token material                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 32 bytes of CSPRNG → 43 base64url characters.
 *
 * 256 bits is the same entropy BetterAuth's own email-verification and
 * password-reset tokens are minted at, and it is the number that matters: the
 * only attack is guessing, and 2^256 is not a search anyone conducts. The
 * token is compared by hash (below), so a leaked database row does not hand
 * over a redeemable credential either.
 */
const TOKEN_BYTES = 32;

/** 72 hours — the window the model doc records, and the copy in the email. */
export const STAFF_INVITATION_TTL_MS = 72 * 60 * 60 * 1000;

/** The only role this app mints by invitation. */
export const INVITABLE_STAFF_ROLES: readonly UserRole[] = ["STAFF", "ADMIN"];

/**
 * Lowercase + trim, the single normalisation every writer uses.
 *
 * The write path, the read path and the DB partial unique index
 * (`staff_invitations_email_pending_key`, on `lower(email)`) all apply the
 * same fold, so "one pending invite per person" means one row regardless of
 * how the address was typed.
 */
export function normalizeStaffEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A fresh raw token. Returned ONCE, to the email or the operator's terminal. */
export function mintStaffInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256 hex of the token. This is the value that is stored.
 *
 * Not bcrypt/argon2, and that is a considered choice rather than a shortcut:
 * see the `tokenHash` doc in prisma/schema.prisma. The comparison below is
 * constant-time for the same reason — there is no timing signal worth reading
 * off a 256-bit value, but the habit is what keeps this helper correct if the
 * primitive is ever swapped.
 */
export function hashStaffInvitationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Constant-time compare of two hex digests, length-safe.
 *
 * `timingSafeEqual` throws on a length mismatch, and a length mismatch is
 * exactly the shape an attacker probes for, so the length check comes first
 * and the equality result is folded into it.
 */
export function tokenHashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Why an accept was refused — a code the catalog has copy for. */
export type StaffInvitationRefusalCode =
  | "SETUP_TOKEN_INVALID"
  | "SETUP_TOKEN_EXPIRED"
  | "SETUP_TOKEN_ALREADY_USED"
  | "INVITATION_REVOKED";

export type StaffInvitationLookup =
  | {
      invitation: {
        id: string;
        email: string;
        role: UserRole;
        status: StaffInvitationStatus;
        expiresAt: Date;
        sentCount: number;
        acceptedAt: Date | null;
        revokedAt: Date | null;
      };
      refusal?: never;
    }
  | { invitation?: never; refusal: StaffInvitationRefusalCode };

/**
 * Resolve a raw token to its invitation, or to the reason it cannot be used.
 *
 * The lookup is by `tokenHash` (`@unique`), so it is a single indexed read and
 * an unknown token is indistinguishable from a wrong one — no row, no code,
 * no timing difference of consequence.
 *
 * Status is read AFTER the row, never in the WHERE, because each terminal
 * state has its own code: a revoked invitation and a spent one are different
 * conversations with the person holding the link.
 */
export async function lookupStaffInvitationByToken(
  rawToken: string,
): Promise<StaffInvitationLookup> {
  const invitation = await prisma.staffInvitation.findUnique({
    where: { tokenHash: hashStaffInvitationToken(rawToken) },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      sentCount: true,
      acceptedAt: true,
      revokedAt: true,
    },
  });
  if (!invitation) return { refusal: "SETUP_TOKEN_INVALID" };

  switch (invitation.status) {
    case "REVOKED":
      return { refusal: "INVITATION_REVOKED" };
    case "ACCEPTED":
      // The single-use answer. A second redemption of the same link is a
      // 410-shaped refusal, never a 500 and never a silent success — and it
      // is the reason the accept flow does NOT mint a session (see the route).
      return { refusal: "SETUP_TOKEN_ALREADY_USED" };
    case "EXPIRED":
      return { refusal: "SETUP_TOKEN_EXPIRED" };
    case "PENDING":
      break;
  }
  // Checked outside the switch on purpose: an ACCEPTED invitation past its
  // expiry is "already used", not "expired" — the person already has the
  // account, and telling them the link expired sends them to ask for another.
  if (invitation.expiresAt.getTime() <= Date.now()) {
    return { refusal: "SETUP_TOKEN_EXPIRED" };
  }
  return { invitation };
}

/**
 * Atomically claim a PENDING invitation.
 *
 * CAS via `updateMany WHERE status = PENDING`, the shape
 * `app/api/organizations/invitations/accept/route.ts` uses and for the same
 * reason: two concurrent accepts from the same link both pass every check
 * above, and only the database can decide which one proceeds. `count === 0`
 * means the other caller won — the caller turns that into a
 * `SETUP_TOKEN_ALREADY_USED`, which is the truth from the loser's side.
 *
 * `acceptedAt` is stamped here rather than by the caller so "when" and "by
 * which claim" cannot disagree.
 */
export async function claimStaffInvitation(
  tx: Tx,
  invitationId: string,
  acceptedUserId: string,
): Promise<boolean> {
  const claim = await tx.staffInvitation.updateMany({
    where: { id: invitationId, status: "PENDING" },
    data: {
      status: "ACCEPTED",
      acceptedAt: new Date(),
      acceptedUserId,
    },
  });
  return claim.count === 1;
}

/* -------------------------------------------------------------------------- */
/* The password hash — single-sourced with BetterAuth                          */
/* -------------------------------------------------------------------------- */

/**
 * bcrypt cost factor for a credential created outside BetterAuth.
 *
 * MUST equal the `bcrypt.hash(password, 12)` in `lib/auth.ts`
 * (`emailAndPassword.password.hash`). bcrypt embeds the cost in the digest
 * itself, so a *lower* cost still verifies — a higher one would not — which
 * makes "we quietly used 10 here" invisible until it matters. The constant is
 * named and exported precisely so it can be asserted in a test rather than
 * eyeballed in two files.
 */
export const STAFF_PASSWORD_BCRYPT_ROUNDS = 12;

/** Mirrors `minPasswordLength` / `maxPasswordLength` in `lib/auth.ts`. */
export const STAFF_PASSWORD_MIN_LENGTH = 8;
export const STAFF_PASSWORD_MAX_LENGTH = 128;

/**
 * THE single source of the credential hash for a staff account created by
 * invitation.
 *
 * ## Why this function exists at all
 *
 * `app/api/user/staff/route.ts` used to call `bcrypt.hash(password, 12)`
 * inline, bypassing BetterAuth entirely. That is fine in isolation — bcrypt is
 * what BetterAuth verifies against — and catastrophic in practice: it is a
 * second, unwatched copy of an authentication decision. Change the cost in
 * `lib/auth.ts` and this site keeps minting old-cost hashes forever; add
 * argon2 there and every staff account created through this route becomes
 * unloginable. So the algorithm is owned in ONE place and borrowed.
 *
 * BetterAuth is the owner; this module is the borrower. `lib/auth.ts` must
 * route its own `hash` through here so there is exactly one literal `12` in
 * the codebase:
 *
 * ```diff
 *  // lib/auth.ts — emailAndPassword.password
 *    password: {
 * -   hash: async (password) => {
 * -     return bcrypt.hash(password, 12);
 * -   },
 * +   hash: (password) => hashStaffPassword(password),
 *      verify: async ({ password, hash }) => {
 *        return bcrypt.compare(password, hash);
 *      },
 *    },
 * ```
 *
 * (that import is NOT applied here — `lib/auth.ts` belongs to another change
 * stream; the edit is reported, not made).
 *
 * ## Password strength
 *
 * BetterAuth's `emailAndPassword.password` config also sets
 * `minPasswordLength: 8` / `maxPasswordLength: 128`. This function enforces
 * them itself because it runs where no BetterAuth zod layer sits. The *policy*
 * is still the operator's: a staff password is not a customer credential, and
 * a complexity rule (one capital, one digit) buys nothing against a phished
 * session while making the generated "please don't reuse your Gmail password"
 * advice harder to follow. Length + the mandatory second factor (enforced in
 * `lib/auth-helpers.ts`) is the real control.
 */
export async function hashStaffPassword(password: string): Promise<string> {
  if (password.length < STAFF_PASSWORD_MIN_LENGTH) {
    throw new StaffPasswordError(
      `Password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters.`,
    );
  }
  if (password.length > STAFF_PASSWORD_MAX_LENGTH) {
    throw new StaffPasswordError(
      `Password must be at most ${STAFF_PASSWORD_MAX_LENGTH} characters.`,
    );
  }
  return bcrypt.hash(password, STAFF_PASSWORD_BCRYPT_ROUNDS);
}

/** A rejected password, so the route answers 400 with the reason, not 500. */
export class StaffPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaffPasswordError";
  }
}

/* -------------------------------------------------------------------------- */
/* The invitation email — staged inside the caller's transaction               */
/* -------------------------------------------------------------------------- */

/**
 * The outbox payload, shaped exactly as `StagedSend` in `lib/email/index.ts`
 * so it can be handed to `attemptStagedEmail` unchanged.
 *
 * Declared locally rather than imported because `StagedSend` is the type of a
 * return value, and a `stageOrgInvitationEmail`-shaped wrapper for staff would
 * have to live in `lib/email/index.ts` — which is a shared file with its own
 * owners. Rebuilding the two-field object here is one line and buys
 * autonomy; the *contract* (stage now, attempt in `after()`) is unchanged.
 */
export interface StagedStaffInvitationEmail {
  emailType: string;
  staged: StagedEmail | null;
  message: RenderedEmail;
}

const STAFF_INVITATION_EMAIL_TYPE = "STAFF_INVITATION";

/** The link the invitee opens. One path, one token, read from the query. */
export function staffInvitationUrl(rawToken: string): string {
  return `${getAppUrl()}/auth/staff-invite?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Render + stage the invitation mail on the caller's transaction, so a rolled
 * back invite leaves no mail and a committed invite is never silent.
 *
 * The two-phase contract is `lib/email`'s, not ours: `stage()` writes the
 * `FailedEmail` outbox row now (inside `tx`), and the caller runs
 * `attemptStagedEmail()` from `scheduleAfter()` so the request never waits on
 * Resend. A render failure returns `null` rather than throwing — the invite
 * row is still valid and the admin can resend, and a template bug must not
 * roll back an operator's onboarding.
 */
export async function stageStaffInvitationEmail(
  input: {
    email: string;
    /** The inviting admin's display name, or the bootstrap script's. */
    inviterName: string;
    role: UserRole;
    rawToken: string;
    expiresAt: Date;
  },
  tx: Pick<Tx, "failedEmail" | "emailSuppression">,
): Promise<StagedStaffInvitationEmail | null> {
  const inviteUrl = staffInvitationUrl(input.rawToken);
  let rendered: { html: string; text: string };
  try {
    rendered = await renderEmail(
      StaffInvitationEmail({
        inviterName: input.inviterName,
        role: input.role,
        inviteUrl,
        expiresAt: input.expiresAt.toISOString(),
      }) as ReactElement,
    );
  } catch (error) {
    reportSentryError(error, {
      subsystem: "email",
      op: "render:staff-invitation",
      expected: true,
    });
    return null;
  }
  const message: RenderedEmail = {
    from: SENDERS.notifications,
    to: input.email,
    subject: `You've been invited to join Familiarise as ${
      input.role === "ADMIN" ? "an administrator" : "a staff member"
    }`,
    ...rendered,
  };
  const staged = await stage(message, STAFF_INVITATION_EMAIL_TYPE, {
    tx,
    // The outbox row is anchored on the INVITATION, not on a user id: at
    // stage time the recipient has no User row yet, which is the whole point.
    entityRef: `staff-invitation:${input.email}`,
  });
  return { emailType: STAFF_INVITATION_EMAIL_TYPE, staged, message };
}

/** The budget a staged invite is attempted under — the API-route budget. */
export const STAFF_INVITATION_EMAIL_BUDGET_MS = EMAIL_BUDGET_MS.REQUEST;

/** Re-exported so the schema-typed callers do not import @prisma/client. */
export type { StaffInvitationStatus, UserRole };
export type StaffInvitationRow = Prisma.StaffInvitationGetPayload<
  Record<string, never>
>;
