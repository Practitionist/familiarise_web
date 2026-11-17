import * as React from "react";
import type { CollaboratorRole } from "@prisma/client";
import CollaborationLifecycleEmail, {
  collaborationLifecycleSubject,
  type CohostChangeEvent,
  type CollaborationLifecycleEvent,
} from "@/emails/collaborations/CollaborationLifecycleEmail";
import { ROLE_INFO } from "@/lib/collaborators/roles";
import { goHref } from "@/lib/dashboard/go";
import prisma from "@/lib/prisma";
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

/**
 * The seat holders' emails a co-host change owes once it has committed. Plain
 * data, so a caller can carry it out of the transaction that read it.
 */
export interface OwedCohostEmails {
  event: CohostChangeEvent;
  /** The plan's seat holders, read by the transaction that made the change. */
  userIds: string[];
  /** Null when the co-host is not named. */
  cohostName: string | null;
  planTitle: string;
  planType: "webinar" | "class";
  collaboratorId: string;
}

/** One claim per seat holder and change makes the email at-most-once. */
const COHOST_EMAIL_CLAIM_SCOPE = "collaborator.cohost-change-email";
/** A claim outlives any repeat of the change that owes the email. */
const COHOST_EMAIL_CLAIM_MS = 7 * 24 * 60 * 60 * 1000;

function cohostChangeSpec(owed: OwedCohostEmails): RecipientEmailSpec {
  const event = owed.event.toLowerCase();
  return {
    emailType: `plan_${event}`,
    category: null,
    traceRenderFailure: true,
    entityRef: `collaborator:${owed.collaboratorId}:${event}`,
    subject: () =>
      collaborationLifecycleSubject({
        event: owed.event,
        planTitle: owed.planTitle,
        roleLabel: "",
      }),
    render: (r) =>
      React.createElement(CollaborationLifecycleEmail, {
        recipientName: greet(r),
        event: owed.event,
        collaboratorName: owed.cohostName ?? undefined,
        planTitle: owed.planTitle,
        planKindLabel: planKindLabel(owed.planType),
        roleLabel: "",
        dashboardUrl: absolute(goHref("client", "appointments")),
      }),
  };
}

/**
 * Stages one batch of the seat holders' emails of a committed co-host change.
 * Recipients are read and messages rendered outside any transaction; the
 * claims and the rows then commit together in one short transaction of two
 * statements, so a seat holder already claimed for this change gets nothing.
 */
export async function stageCohostChangeEmailBatch(
  owed: OwedCohostEmails,
  userIds: string[],
): Promise<{ list: StagedRecipientEmail[]; emailType: string }> {
  const spec = cohostChangeSpec(owed);
  const { emailType, entityRef } = spec;
  const none = { list: [], emailType };
  const claimed = await prisma.idempotencyRecord.findMany({
    where: {
      scope: COHOST_EMAIL_CLAIM_SCOPE,
      key: entityRef,
      userId: { in: userIds },
    },
    select: { userId: true },
  });
  const done = new Set(claimed.map((c) => c.userId));
  const unclaimed = userIds.filter((userId) => !done.has(userId));
  if (unclaimed.length === 0) return none;

  const prepared = await prepareSpecEmails(spec, unclaimed);
  const screened = await screenForStaging(prepared.messages, emailType);
  const unrendered = prepared.unrendered ?? [];
  const readers = [
    ...screened.map(({ message }) => message.deliveryPolicy?.userId),
    ...unrendered.map((u) => u.deliveryPolicy?.userId),
  ].filter((userId): userId is string => Boolean(userId));
  if (readers.length === 0) return none;

  const now = new Date();
  const list = await prisma.$transaction(async (tx) => {
    const fresh = await tx.idempotencyRecord.createManyAndReturn({
      data: readers.map((userId) => ({
        scope: COHOST_EMAIL_CLAIM_SCOPE,
        key: entityRef,
        userId,
        requestHash: entityRef,
        completedAt: now,
        expiresAt: new Date(now.getTime() + COHOST_EMAIL_CLAIM_MS),
      })),
      skipDuplicates: true,
      select: { userId: true },
    });
    const won = new Set(fresh.map((c) => c.userId));
    const mine = (policy: { userId: string } | undefined) =>
      policy !== undefined && won.has(policy.userId);
    return stageScreenedEmails(
      tx,
      {
        prepared: {
          ...prepared,
          unrendered: unrendered.filter((u) => mine(u.deliveryPolicy)),
        },
        screened: screened.filter((one) => mine(one.message.deliveryPolicy)),
      },
      entityRef,
    );
  });
  return { list, emailType };
}
