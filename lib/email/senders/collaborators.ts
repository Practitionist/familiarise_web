import * as React from "react";
import type { CollaboratorRole } from "@prisma/client";
import CollaborationLifecycleEmail, {
  collaborationLifecycleSubject,
  type CohostChangeEvent,
  type CollaborationLifecycleEvent,
} from "@/emails/collaborations/CollaborationLifecycleEmail";
import { ROLE_INFO } from "@/lib/collaborators/roles";
import { goHref } from "@/lib/dashboard/go";
import type { Tx } from "@/lib/prisma";
import { screenForStaging } from "../deliver";
import {
  stageScreenedEmails,
  type StagedRecipientEmail,
} from "../send-to-recipients";
import {
  absolute,
  defineLifecycleStager,
  greet,
  prepareSpecEmails,
  whenText,
  type RecipientEmailSpec,
} from "./shared";

export interface CollaboratorLifecycleEmailArgs {
  event: CollaborationLifecycleEvent;
  recipientUserId: string;
  /** The reader is the collaborator; otherwise the plan's host side. */
  toCollaborator: boolean;
  /** The person who made the change, when one did and they are not the reader. */
  actorName?: string;
  collaboratorName?: string;
  planTitle: string;
  planType: "webinar" | "class";
  role: CollaboratorRole;
  revenueShareBps: number;
  collaboratorId: string;
  /** The row was still an invitation: it never held a place on the team. */
  pendingInvite?: boolean;
  /** When a pending invitation lapses. */
  expiresAt?: Date;
  dashboardUrl: string;
}

const planKindLabel = (planType: "webinar" | "class") =>
  planType === "webinar" ? "Webinar" : "Class";

function buildCollaboratorSpec(args: CollaboratorLifecycleEmailArgs): {
  userIds: string[];
  spec: RecipientEmailSpec;
} {
  const { event, expiresAt } = args;
  const info = ROLE_INFO[args.role];
  const optional = event === "EXPIRING_SOON";

  const spec: RecipientEmailSpec = {
    emailType: `collaborator_${event.toLowerCase()}`,
    // Only the reminder before an invitation lapses follows the reader's switches.
    category: optional ? "appointments" : null,
    traceRenderFailure: !optional,
    entityRef: `collaborator:${args.collaboratorId}:${event.toLowerCase()}`,
    subject: () =>
      collaborationLifecycleSubject({
        event,
        planTitle: args.planTitle,
        collaboratorName: args.collaboratorName,
        roleLabel: info.label,
        toCollaborator: args.toCollaborator,
        pendingInvite: args.pendingInvite,
      }),
    render: (r) =>
      React.createElement(CollaborationLifecycleEmail, {
        recipientName: greet(r),
        event,
        actorName: args.actorName,
        collaboratorName: args.collaboratorName,
        planTitle: args.planTitle,
        planKindLabel: planKindLabel(args.planType),
        roleLabel: info.label,
        roleCan: info.can,
        revenueSharePct: args.revenueShareBps / 100,
        toCollaborator: args.toCollaborator,
        pendingInvite: args.pendingInvite,
        expiresOn: expiresAt ? whenText(expiresAt, r.zone) : undefined,
        dashboardUrl: absolute(args.dashboardUrl),
        unsubscribeUrl: r.unsubscribeUrl,
      }),
  };

  return {
    userIds: [args.recipientUserId],
    spec,
  };
}

/** Stages one recipient's lifecycle email inside the collaborator transition's transaction. */
export const stageCollaboratorLifecycleEmail =
  defineLifecycleStager<CollaboratorLifecycleEmailArgs>(buildCollaboratorSpec);

export interface CohostChangeEmailArgs {
  event: CohostChangeEvent;
  /** The plan's seat holders. */
  userIds: string[];
  /** Null when the co-host is not named. */
  cohostName: string | null;
  planTitle: string;
  planType: "webinar" | "class";
  collaboratorId: string;
}

/**
 * Stages the seat holders' notice of a co-host change inside the transaction
 * that made it, in one read of the recipients, one of the suppression list and
 * one insert, so a full roster costs the transaction three statements.
 */
export async function stageCohostChangeEmails(
  tx: Tx,
  args: CohostChangeEmailArgs,
): Promise<{ list: StagedRecipientEmail[]; emailType: string }> {
  const emailType = `plan_${args.event.toLowerCase()}`;
  const spec: RecipientEmailSpec = {
    emailType,
    category: null,
    traceRenderFailure: true,
    entityRef: `collaborator:${args.collaboratorId}:${args.event.toLowerCase()}`,
    subject: () =>
      collaborationLifecycleSubject({
        event: args.event,
        planTitle: args.planTitle,
        roleLabel: "",
      }),
    render: (r) =>
      React.createElement(CollaborationLifecycleEmail, {
        recipientName: greet(r),
        event: args.event,
        collaboratorName: args.cohostName ?? undefined,
        planTitle: args.planTitle,
        planKindLabel: planKindLabel(args.planType),
        roleLabel: "",
        dashboardUrl: absolute(goHref("client", "appointments")),
      }),
  };
  const prepared = await prepareSpecEmails(spec, args.userIds, tx);
  const screened = await screenForStaging(prepared.messages, emailType, tx);
  return {
    list: await stageScreenedEmails(tx, { prepared, screened }, spec.entityRef),
    emailType,
  };
}
