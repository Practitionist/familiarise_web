/**
 * Enterprise SSO notices: platform ADMINs hear about a provider awaiting
 * approval, and the org's OWNERs hear when staff approve or revoke it.
 */

import * as React from "react";
import SsoProviderEmail, {
  ssoProviderSubject,
  type SsoProviderEmailKind,
} from "@/emails/organizations/SsoProviderEmail";
import prisma from "@/lib/prisma";
import { EMAIL_BUDGET_MS, SENDERS } from "../config";
import type { SendToRecipientsResult } from "../send-to-recipients";
import { absolute, greet, sendSpecGuarded } from "./shared";

export interface SsoProviderEmailArgs {
  organizationId: string;
  orgName: string;
  providerId: string;
  domains: string[];
  issuer: string;
  reason?: string;
}

function send(
  kind: SsoProviderEmailKind,
  args: SsoProviderEmailArgs,
  userIds: string[],
  actionUrl: string,
): Promise<SendToRecipientsResult> {
  return sendSpecGuarded(
    {
      emailType: `SSO_PROVIDER_${kind}`,
      category: null,
      from: SENDERS.security,
      entityRef: `sso-provider:${args.providerId}`,
      subject: () => ssoProviderSubject(kind, args.orgName),
      render: (r) =>
        React.createElement(SsoProviderEmail, {
          kind,
          recipientName: greet(r),
          orgName: args.orgName,
          providerId: args.providerId,
          domains: args.domains,
          issuer: args.issuer,
          reason: args.reason,
          actionUrl: absolute(actionUrl),
        }),
    },
    userIds,
    EMAIL_BUDGET_MS.REQUEST,
  );
}

/** To every platform ADMIN: a provider is waiting in the approval queue. */
export async function sendSsoProviderSubmittedEmail(
  args: SsoProviderEmailArgs,
): Promise<SendToRecipientsResult> {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  return send(
    "SUBMITTED",
    args,
    admins.map((a) => a.id),
    `/dashboard/admin/organizations/${args.organizationId}`,
  );
}

/** To the org's ACTIVE OWNERs: staff approved or revoked their provider. */
export async function sendSsoProviderDecisionEmail(
  args: SsoProviderEmailArgs & { approved: boolean },
): Promise<SendToRecipientsResult> {
  const owners = await prisma.membership.findMany({
    where: {
      organizationId: args.organizationId,
      role: "OWNER",
      status: "ACTIVE",
    },
    select: { userId: true },
  });
  return send(
    args.approved ? "APPROVED" : "REVOKED",
    args,
    owners.map((o) => o.userId),
    `/dashboard/organization/${args.organizationId}/settings/sso`,
  );
}
