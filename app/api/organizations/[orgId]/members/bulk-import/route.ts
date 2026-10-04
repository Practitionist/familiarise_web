/**
 * POST /api/organizations/[orgId]/members/bulk-import
 *
 * Wave-8 (#1230) — enterprise provisioning. Accepts a JSON array of
 * {email, name} entries and sends each person a LEARNER invitation.
 *
 * #1846 bucket C — joining is invite + accept only, so an import creates
 * Invitations, never memberships. It used to create PENDING LEARNER rows
 * that nothing ever activated, emailed a link whose token was the orgId,
 * created User rows for unknown emails, skipped the canSponsor check, and
 * reactivated REMOVED members without their consent (N9). Each person now
 * accepts their own invitation, with the DPDP consent check, through the
 * same `issueInvitation` helper "Add people" uses. A removed learner is
 * invited back like anyone else; accepting reactivates their row.
 *
 * Each entry runs in its own Serializable transaction with retry, so
 * concurrent imports cannot overshoot the unverified-org seat cap, and one
 * bad row does not fail the batch. Bulk REMOVE and bulk ROLE-CHANGE remain
 * 405 (anti-lockout risk).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  DomainVerificationRequiredError,
  UNVERIFIED_ORG_SEAT_CAP,
} from "@/lib/enterprise/governance";
import {
  issueInvitation,
  type IssueInvitationInput,
} from "@/lib/enterprise/invitations";
import { MembershipGuardError } from "@/lib/enterprise/membership-guards";
import { attemptTrigger, type StagedTrigger } from "@/lib/novu";
import {
  attemptStagedEmail,
  EMAIL_BUDGET_MS,
  type StagedSend,
} from "@/lib/email";
import { scheduleAfter } from "@/lib/api/after-safe";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

const EntrySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  // Kept for the CSV shape; the invitee chooses their own name at signup.
  name: z.string().trim().min(1).max(200),
});

const BodySchema = z.object({
  entries: z.array(EntrySchema).min(1).max(200),
});

/** Invitations sent by an import expire like a single invite does. */
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface RowResult {
  email: string;
  ok: boolean;
  invitationId?: string;
  error?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "invitations.manage",
    requireActive: true,
  });
  if (access.error) return access.error;

  if (
    access.org.status === "SUSPENDED" ||
    access.org.status === "DEACTIVATED"
  ) {
    return NextResponse.json({ error: "ORG_NOT_ACTIVE" }, { status: 409 });
  }
  // Everyone imported joins as a LEARNER, which only a sponsoring org funds
  // (the same gate the single invite applies).
  if (!access.org.canSponsor) {
    return NextResponse.json(
      {
        error: "LEARNER can only be assigned on sponsor-capable organizations",
        code: "LEARNER_REQUIRES_CANSPONSOR",
      },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Dedupe within batch
  const seen = new Set<string>();
  const deduped = parsed.data.entries.filter((e) => {
    if (seen.has(e.email)) return false;
    seen.add(e.email);
    return true;
  });

  const base: Omit<IssueInvitationInput, "email"> = {
    orgId,
    orgName: access.org.name,
    role: "LEARNER",
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    inviter: {
      userId: access.session.user.id,
      name:
        access.session.user.name ?? access.session.user.email ?? "An operator",
      membershipId: access.member.id,
      role: access.member.role,
    },
    origin: new URL(req.url).origin,
  };

  const results: RowResult[] = [];
  const stagedBells: StagedTrigger[] = [];
  const stagedEmails: StagedSend[] = [];
  for (const entry of deduped) {
    const result = await inviteEntry({ ...base, email: entry.email });
    results.push({ email: entry.email, ...result.row });
    stagedBells.push(...result.bells);
    if (result.email) stagedEmails.push(result.email);
  }

  // The notices were staged inside each entry's transaction (#1653); only
  // the vendor attempts run after the response, in one after(), so the
  // provider budgets do not multiply by the batch size (up to 200).
  scheduleAfter(async () => {
    for (const row of stagedBells) await attemptTrigger(row);
    for (const staged of stagedEmails) {
      await attemptStagedEmail(staged, EMAIL_BUDGET_MS.AUTH);
    }
  }, "org.bulk-import.post-commit");

  const invited = results.filter((r) => r.ok).length;
  return NextResponse.json(
    {
      // `imported` is the pre-#1846 name the dialog still reads.
      imported: invited,
      invited,
      failed: results.length - invited,
      results,
    },
    { status: 200 },
  );
}

async function inviteEntry(input: IssueInvitationInput): Promise<{
  row: Omit<RowResult, "email">;
  bells: StagedTrigger[];
  email: StagedSend | null;
}> {
  try {
    const issued = await withSerializableRetry(() =>
      prisma.$transaction((tx) => issueInvitation(tx, input), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      }),
    );
    return {
      row: { ok: true, invitationId: issued.invitation.id },
      bells: issued.stagedBells,
      email: issued.stagedEmail,
    };
  } catch (err) {
    let error = "Internal error";
    if (err instanceof MembershipGuardError) error = err.message;
    else if (err instanceof DomainVerificationRequiredError) {
      error = `Seat cap (${UNVERIFIED_ORG_SEAT_CAP}) reached — verify a domain to add more`;
    } else {
      console.error("[bulk-import] entry failed:", err);
    }
    return { row: { ok: false, error }, bells: [], email: null };
  }
}
