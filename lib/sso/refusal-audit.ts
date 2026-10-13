import prisma from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { captureThrottled } from "@/lib/observability/throttled-capture";

export type SsoRefusalCode = "SSO_REQUIRED" | "SSO_EMAIL_DOMAIN_MISMATCH";

const DEDUPE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Records an SSO sign-in refusal in the org's audit log, at most once per
 * email, code and hour. Best effort: a failure here never changes the refusal.
 */
export async function recordSsoRefusal(input: {
  organizationId: string;
  code: SsoRefusalCode;
  email: string;
  path?: string | null;
}): Promise<void> {
  const email = input.email.toLowerCase();
  try {
    const recent = await prisma.orgAuditLog.findFirst({
      where: {
        organizationId: input.organizationId,
        action: AUDIT_ACTIONS.SETTINGS.SSO_SIGN_IN_REFUSED,
        createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
        AND: [
          { details: { path: ["email"], equals: email } },
          { details: { path: ["code"], equals: input.code } },
        ],
      },
      select: { id: true },
    });
    if (recent) return;
    await prisma.orgAuditLog.create({
      data: {
        organizationId: input.organizationId,
        category: "SETTINGS",
        action: AUDIT_ACTIONS.SETTINGS.SSO_SIGN_IN_REFUSED,
        description: `Sign-in refused for ${email} (${input.code})`,
        details: { email, code: input.code, path: input.path ?? null },
      },
    });
  } catch (error) {
    captureThrottled("sso:refusal-audit", error, {
      subsystem: "enterprise",
      op: "sso-refusal-audit",
      expected: false,
    });
  }
}
