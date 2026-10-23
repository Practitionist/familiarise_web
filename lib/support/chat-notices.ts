import type { Tx } from "@/lib/prisma";
import { MESSAGE_REVIEW_ARTICLE_HREF } from "@/lib/compliance/purpose-codes";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { getAppUrl } from "@/lib/url";
import { caseCorrespondentIds } from "./case-access";
import { caseKeyOf } from "./case-key";
import type { ChatCase } from "./chat-access";

/**
 * Bells the case parties. Correspondents get the case link; other parties get
 * the help article and never the case title or reference.
 */
export async function stagePartyBells(
  tx: Tx,
  supportCase: Pick<
    ChatCase,
    | "id"
    | "referenceNumber"
    | "organizationId"
    | "ownershipScope"
    | "submitterUserId"
    | "externalRequesterEmail"
  >,
  scopeUserIds: string[],
  status: string,
  key: string,
): Promise<StagedTrigger[]> {
  const users = await tx.user.findMany({
    where: { id: { in: scopeUserIds }, banned: { not: true } },
    select: { id: true },
  });
  const recipients = users.map((u) => u.id);
  const correspondents = new Set(await caseCorrespondentIds(supportCase, tx));
  const own = recipients.filter((id) => correspondents.has(id));
  const others = recipients.filter((id) => !correspondents.has(id));
  const staged: StagedTrigger[] = [];
  if (own.length) {
    const bell = await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
      recipients: own,
      dedupeKey: `${key}:case`,
      entityRef: `${key}:case`,
      payload: {
        ticketId: supportCase.id,
        reference: supportCase.referenceNumber,
        ticketTitle: "Booking chat",
        status,
        dashboardUrl: supportRequestHref(
          caseKeyOf({ kind: "case", id: supportCase.id }),
          supportCase.organizationId,
        ),
        ...notificationScope(supportCase.organizationId),
      },
    });
    if (bell) staged.push(bell);
  }
  if (others.length) {
    const bell = await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
      recipients: others,
      dedupeKey: `${key}:party`,
      entityRef: `${key}:party`,
      payload: {
        ticketId: supportCase.id,
        ticketTitle: "Booking chat",
        status,
        dashboardUrl: `${getAppUrl()}${MESSAGE_REVIEW_ARTICLE_HREF}`,
        ...notificationScope(null),
      },
    });
    if (bell) staged.push(bell);
  }
  return staged;
}

export const INTERVENTION_JOINED_STATUS = "joined by Familiarise Support";
export const CHAT_REVIEWED_STATUS =
  "reviewed: our team read messages from your booking chat";
