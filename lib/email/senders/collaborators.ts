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

function buildLifecycleSender(event: CollaborationLifecycleEvent) {
  return defineBudgetedEmailSender<CollaboratorLifecycleEmailArgs>((args) => {
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
  });
}

export const sendCollaboratorInvitedEmail = buildLifecycleSender("INVITED");
export const sendCollaboratorAcceptedEmail = buildLifecycleSender("ACCEPTED");
export const sendCollaboratorDeclinedEmail = buildLifecycleSender("DECLINED");
export const sendCollaboratorRemovedEmail = buildLifecycleSender("REMOVED");
export const sendCollaboratorWithdrawnEmail = buildLifecycleSender("WITHDRAWN");
export const sendCollaboratorInviteExpiredEmail =
  buildLifecycleSender("EXPIRED");
