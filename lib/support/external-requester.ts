import { Prisma } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import {
  stage as stageEmail,
  type RenderedEmail,
  type StagedEmail,
} from "@/lib/email/deliver";
import { DEFAULT_FROM_ADDRESS } from "@/lib/email/config";
import { getAppUrl } from "@/lib/url";
import { canSignLinks, safeEquals, signToken } from "@/lib/auth/link-signing";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { isPresenterAuthoredMessage } from "@/lib/support/case-message-actor";

/**
 * Anonymous public grievances are held by this non-staff system account, so no
 * real operator's deletion cascades into them. Created on first use.
 */

/** Newest withheld replies (and decisions) mailed once the address is confirmed. */
const WITHHELD_DIGEST_LIMIT = 50;
export const PUBLIC_INTAKE_USER_ID = "system-public-grievance-intake";
export const PUBLIC_INTAKE_USER_EMAIL =
  "public-grievance-intake@system.familiarise.invalid";

export async function resolvePublicIntakeUserId(): Promise<string> {
  const select = { id: true } as const;
  const existing = await prisma.user.findUnique({
    where: { email: PUBLIC_INTAKE_USER_EMAIL },
    select,
  });
  if (existing) return existing.id;
  try {
    const created = await prisma.user.create({
      data: {
        id: PUBLIC_INTAKE_USER_ID,
        email: PUBLIC_INTAKE_USER_EMAIL,
        name: "Public grievance intake",
        emailVerified: true,
        onboardingCompleted: true,
      },
      select,
    });
    return created.id;
  } catch (error) {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== "P2002"
    )
      throw error;
    const winner = await prisma.user.findUniqueOrThrow({
      where: { email: PUBLIC_INTAKE_USER_EMAIL },
      select,
    });
    return winner.id;
  }
}

const VERIFY_PURPOSE = "support-external-email";
export const EXTERNAL_EMAIL_VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** `SupportCaseEvent.toValue` recording that the external address was confirmed. */
export const EXTERNAL_EMAIL_VERIFIED = "EXTERNAL_EMAIL_VERIFIED";

const tokenSubject = (caseId: string, email: string) =>
  `${caseId}|${email.trim().toLowerCase()}`;

export function externalEmailToken(
  caseId: string,
  email: string,
  issuedAt: number,
): string {
  return signToken(VERIFY_PURPOSE, tokenSubject(caseId, email), issuedAt);
}

export function externalEmailVerifyUrl(
  caseId: string,
  email: string,
  issuedAt: number = Date.now(),
): string {
  const token = externalEmailToken(caseId, email, issuedAt);
  return `${getAppUrl()}/api/support/external-verify?case=${encodeURIComponent(
    caseId,
  )}&issued=${issuedAt}&token=${token}`;
}

/** Rejects forged, expired and future-dated links alike. */
export function verifyExternalEmailToken(
  caseId: string,
  email: string,
  token: string,
  issuedAt: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
  if (issuedAt - now > MAX_FUTURE_SKEW_MS) return false;
  if (now - issuedAt > EXTERNAL_EMAIL_VERIFY_TTL_MS) return false;
  return safeEquals(token, () => externalEmailToken(caseId, email, issuedAt));
}

export async function isExternalEmailVerified(
  db: Pick<Tx, "supportCaseEvent">,
  caseId: string,
): Promise<boolean> {
  const event = await db.supportCaseEvent.findFirst({
    where: {
      caseId,
      kind: "VISIBILITY_CHANGED",
      toValue: EXTERNAL_EMAIL_VERIFIED,
    },
    select: { id: true },
  });
  return event !== null;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function render(to: string, subject: string, text: string): RenderedEmail {
  return {
    from: DEFAULT_FROM_ADDRESS,
    to,
    subject,
    text,
    html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
  };
}

/** The reference-only notice an unconfirmed address receives instead of content. */
export function unverifiedNoticeText(
  caseId: string,
  email: string,
  reference: string,
  lead = "There is an update on this grievance. We send its content only to an address that has been confirmed.",
): string {
  const confirm = canSignLinks()
    ? `Confirm this address to receive our responses by email:\n${externalEmailVerifyUrl(caseId, email)}`
    : "Contact us quoting this reference to receive our responses.";
  return [
    `Reference: ${reference}`,
    lead,
    confirm,
    "If you did not contact Familiarise, you can ignore this email.",
  ].join("\n\n");
}

/** The intake receipt: the reference and the confirmation link, nothing else. */
export function stageExternalIntakeReceiptTx(
  tx: Tx,
  input: { caseId: string; reference: string; to: string },
): Promise<StagedEmail | null> {
  return stageEmail(
    render(
      input.to,
      `Grievance received — ${input.reference}`,
      unverifiedNoticeText(
        input.caseId,
        input.to,
        input.reference,
        "We received your grievance. We email our responses only after this address is confirmed.",
      ),
    ),
    "SUPPORT_TICKET_RECEIVED",
    { tx, entityRef: `case-created:${input.caseId}` },
  );
}

/**
 * Stages an email to an anonymous complainant. Staff content goes only to a
 * confirmed address; until then the email carries the reference and a link.
 */
export async function stageExternalRequesterEmail(
  input: {
    caseId: string;
    reference: string;
    to: string;
    subject: string;
    text: string;
    emailType: string;
    entityRef: string;
  },
  tx?: Tx,
): Promise<{ staged: StagedEmail | null; message: RenderedEmail }> {
  const verified = await isExternalEmailVerified(tx ?? prisma, input.caseId);
  const message = render(
    input.to,
    input.subject,
    verified
      ? input.text
      : unverifiedNoticeText(input.caseId, input.to, input.reference),
  );
  const staged = await stageEmail(message, input.emailType, {
    tx,
    entityRef: input.entityRef,
  });
  return { staged, message };
}

export type ConfirmExternalEmailOutcome =
  "VERIFIED" | "ALREADY_VERIFIED" | "INVALID";

/**
 * Records the confirmation once and sends the staff replies and decisions that
 * were withheld while the address was unconfirmed.
 */
export function confirmExternalRequesterEmail(input: {
  caseId: string;
  token: string;
  issuedAt: number;
}): Promise<ConfirmExternalEmailOutcome> {
  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx): Promise<ConfirmExternalEmailOutcome> => {
        const supportCase = await tx.supportCase.findFirst({
          where: { id: input.caseId, deletedAt: null },
          select: {
            id: true,
            referenceNumber: true,
            externalRequesterEmail: true,
          },
        });
        const email = supportCase?.externalRequesterEmail;
        if (
          !supportCase ||
          !email ||
          !verifyExternalEmailToken(
            supportCase.id,
            email,
            input.token,
            input.issuedAt,
          )
        )
          return "INVALID";
        if (await isExternalEmailVerified(tx, supportCase.id))
          return "ALREADY_VERIFIED";
        await tx.supportCaseEvent.create({
          data: {
            caseId: supportCase.id,
            kind: "VISIBILITY_CHANGED",
            toValue: EXTERNAL_EMAIL_VERIFIED,
            note: "The complainant confirmed their email address.",
          },
        });
        const replies = (
          await tx.supportCaseMessage.findMany({
            where: {
              caseId: supportCase.id,
              sender: "AGENT",
              isInternal: false,
            },
            orderBy: { seq: "asc" },
            take: -WITHHELD_DIGEST_LIMIT,
            select: { body: true, createdAt: true, metadata: true },
          })
        ).filter((reply) => !isPresenterAuthoredMessage(reply.metadata));
        const decisions = await tx.supportCaseDecision.findMany({
          where: { caseId: supportCase.id },
          orderBy: { createdAt: "asc" },
          take: -WITHHELD_DIGEST_LIMIT,
          select: { explanation: true, createdAt: true },
        });
        const truncated =
          replies.length === WITHHELD_DIGEST_LIMIT ||
          decisions.length === WITHHELD_DIGEST_LIMIT;
        const updates = [
          ...replies.map((r) => ({ at: r.createdAt, text: r.body })),
          ...decisions.map((d) => ({
            at: d.createdAt,
            text: `Decision: ${d.explanation}`,
          })),
        ].sort((a, b) => a.at.getTime() - b.at.getTime());
        if (updates.length > 0)
          await stageEmail(
            render(
              email,
              `Support response — ${supportCase.referenceNumber}`,
              [
                `Reference: ${supportCase.referenceNumber}`,
                ...(truncated
                  ? [
                      "Only the most recent updates are shown. Reply to this email if you need the full history.",
                    ]
                  : []),
                ...updates.map(
                  (u) => `${u.at.toISOString().slice(0, 10)}\n${u.text}`,
                ),
              ].join("\n\n"),
            ),
            "SUPPORT_TICKET_RESPONSE",
            { tx, entityRef: `case-verified:${supportCase.id}` },
          );
        return "VERIFIED";
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
