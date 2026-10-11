import * as React from "react";
import CollaborationLifecycleEmail, {
  collaborationLifecycleSubject,
  type CollaborationLifecycleEvent,
} from "@/emails/collaborations/CollaborationLifecycleEmail";
import { goHref } from "@/lib/dashboard/go";
import { collaboratorRoleLabel } from "@/lib/novu/humanize";
import {
  absolute,
  defineBudgetedEmailSender,
  defineLifecycleStager,
  greet,
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

export const sendCollaboratorInvitedEmail =
  defineBudgetedEmailSender<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("INVITED", args),
  );
export const sendCollaboratorAcceptedEmail =
  defineBudgetedEmailSender<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("ACCEPTED", args),
  );
export const sendCollaboratorDeclinedEmail =
  defineBudgetedEmailSender<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("DECLINED", args),
  );
export const sendCollaboratorRemovedEmail =
  defineBudgetedEmailSender<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("REMOVED", args),
  );
export const sendCollaboratorWithdrawnEmail =
  defineBudgetedEmailSender<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("WITHDRAWN", args),
  );
export const sendCollaboratorInviteExpiredEmail =
  defineBudgetedEmailSender<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("EXPIRED", args),
  );

export const stageCollaboratorInvitedEmail =
  defineLifecycleStager<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("INVITED", args),
  );
export const stageCollaboratorAcceptedEmail =
  defineLifecycleStager<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("ACCEPTED", args),
  );
export const stageCollaboratorDeclinedEmail =
  defineLifecycleStager<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("DECLINED", args),
  );
export const stageCollaboratorRemovedEmail =
  defineLifecycleStager<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("REMOVED", args),
  );
export const stageCollaboratorWithdrawnEmail =
  defineLifecycleStager<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("WITHDRAWN", args),
  );
export const stageCollaboratorInviteExpiredEmail =
  defineLifecycleStager<CollaboratorLifecycleEmailArgs>((args) =>
    buildCollaboratorSpec("EXPIRED", args),
  );
