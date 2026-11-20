import type { Tx } from "@/lib/prisma";
import type { RequiredNoticeKind } from "@/lib/notifications/required-notices";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import { caseKeyOf } from "./case-key";

/** Stages a support-case update bell for the recipients, on the caller's transaction. */
export async function stageCaseNotice(
  tx: Tx,
  supportCase: {
    id: string;
    referenceNumber: string;
    title: string;
    organizationId: string | null;
  },
  recipients: string[],
  message: string,
  key: string,
  required?: RequiredNoticeKind,
) {
  await stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    recipients,
    ...(required ? { required } : {}),
    dedupeKey: key,
    entityRef: key,
    payload: {
      ticketId: supportCase.id,
      reference: supportCase.referenceNumber,
      ticketTitle: supportCase.title,
      status: message,
      dashboardUrl: supportRequestHref(
        caseKeyOf({ kind: "case", id: supportCase.id }),
        supportCase.organizationId,
      ),
      ...notificationScope(supportCase.organizationId),
    },
  });
}
