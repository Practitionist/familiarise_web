import * as React from "react";
import CollaborationLifecycleEmail, {
  collaborationLifecycleSubject,
  type CollaborationLifecycleEvent,
} from "@/emails/collaborations/CollaborationLifecycleEmail";
import { goHref } from "@/lib/dashboard/go";
import { collaboratorRoleLabel } from "@/lib/novu/humanize";
import {
  absolute,
  greet,
  stageSpecRequired,
  type StagingTx,
  type RecipientEmailSpec,
} from "./shared";

export interface CollaboratorLifecycleEmailArgs {
  recipientUserId: string;
  actorName: string;
  collaboratorName?: string;
  planTitle: string;
  planType: "webinar" | "class";
  role: string;
  revenueShareBps?: number;
  collaboratorId: string;
}

function buildCollaboratorSpec(
  event: CollaborationLifecycleEvent,
  args: CollaboratorLifecycleEmailArgs,
): { userIds: string[]; spec: RecipientEmailSpec } {
  const roleLabel = collaboratorRoleLabel(args.role);
  const planKindLabel = args.planType === "webinar" ? "Webinar" : "Class";
  const revenueSharePct =
    typeof args.revenueShareBps === "number"
      ? Math.round(args.revenueShareBps) / 100
      : undefined;
  const dashboardUrl = absolute(goHref("expert", "collaborations"));

  const spec: RecipientEmailSpec = {
    emailType: `collaborator_${event.toLowerCase()}`,
    category: null,
    entityRef: `collaborator:${args.collaboratorId}:${event.toLowerCase()}`,
    subject: () =>
      collaborationLifecycleSubject({
        event,
        planTitle: args.planTitle,
        collaboratorName: args.collaboratorName,
        roleLabel,
      }),
    render: (r) =>
      React.createElement(CollaborationLifecycleEmail, {
        recipientName: greet(r),
        event,
        actorName: args.actorName,
        collaboratorName: args.collaboratorName,
        planTitle: args.planTitle,
        planKindLabel,
        roleLabel,
        revenueSharePct,
        dashboardUrl,
      }),
  };

  return {
    userIds: [args.recipientUserId],
    spec,
  };
}

export async function stageCollaboratorLifecycleEmail(
  tx: StagingTx,
  event: CollaborationLifecycleEvent,
  args: CollaboratorLifecycleEmailArgs,
  revision: string,
) {
  const { userIds, spec } = buildCollaboratorSpec(event, args);
  return stageSpecRequired(
    tx,
    { ...spec, entityRef: `${spec.entityRef}:${revision}` },
    userIds,
  );
}
