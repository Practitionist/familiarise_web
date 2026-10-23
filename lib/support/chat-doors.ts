/**
 * The audited doors that open, start and end case-linked booking chat access.
 * Each is a `withOpsAction` tx door with step-up: the grant row, its case
 * event, the OpsActionLog row (carrying the reason) and the OrgAuditLog rows
 * commit together. Stream membership and the intervention's channel lock run
 * after commit; a READ never touches Stream.
 */

import { z } from "zod";

import type { Tx } from "@/lib/prisma";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import {
  joinIntervention,
  leaveIntervention,
} from "@/lib/stream/support-intervention";
import { syncSupportBoundary } from "@/lib/stream/support-boundary";
import {
  EndChatGrantBody,
  OpenChatReadBody,
  StartInterventionBody,
} from "@/schemas/support-chat";
import { endChatGrantTx } from "./chat-access-end";
import { INTERVENTION_JOINED_STATUS, stagePartyBells } from "./chat-notices";
import {
  CASE_CHAT_SELECT,
  CHAT_READ_TTL_MS,
  GRANT_SELECT,
  caseChatRefusal,
  caseNotFound,
  interventionBasisSource,
  isLiveGrant,
  projectGrant,
  resolveCaseChat,
  scopeFor,
  verifiedInterventionBases,
  type CaseChat,
} from "./chat-access";

const HOUR_MS = 3_600_000;
const Params = z.object({ caseId: z.string().min(1).max(64) });

async function loadOpenCase(tx: Tx, params: Record<string, string>) {
  const { caseId } = Params.parse(params);
  const supportCase = await tx.supportCase.findUnique({
    where: { id: caseId },
    select: CASE_CHAT_SELECT,
  });
  if (!supportCase) throw caseNotFound();
  const refusal = caseChatRefusal(supportCase);
  if (refusal) throw refusal;
  return supportCase;
}

/** Org admins never see content; the tenant learns only that staff reviewed a booking chat. */
async function writeOrgAudit(
  tx: Tx,
  chat: CaseChat,
  kind: "READ" | "INTERVENE",
) {
  for (const organizationId of chat.organizationIds) {
    await tx.orgAuditLog.create({
      data: {
        organizationId,
        actorMembershipId: null,
        category: "SYSTEM",
        action:
          kind === "READ"
            ? AUDIT_ACTIONS.SYSTEM.SUPPORT_CHAT_REVIEWED
            : AUDIT_ACTIONS.SYSTEM.SUPPORT_CHAT_INTERVENTION,
        description:
          kind === "READ"
            ? "Familiarise support reviewed a booking chat"
            : "Familiarise Support joined a booking chat",
        details: { appointmentId: chat.appointmentId, kind },
      },
    });
  }
}

/**
 * An expired grant that the sweep hasn't ended yet still holds its partial
 * unique slot; end it so a fresh grant can take the slot.
 */
async function endExpiredGrantsTx(
  tx: Tx,
  where: {
    caseId?: string;
    grantedById?: string;
    kind: "READ" | "INTERVENE";
  } & {
    channelType?: string;
    channelId?: string;
  },
  now: Date,
) {
  const stale = await tx.supportCaseChatAccess.findMany({
    where: { ...where, endedAt: null, expiresAt: { lte: now } },
    select: { id: true, caseId: true, kind: true },
  });
  const ended: string[] = [];
  for (const grant of stale) {
    if (
      await endChatGrantTx(tx, grant, {
        actorId: null,
        reason: "EXPIRED",
        now,
      })
    )
      ended.push(grant.id);
  }
  return ended;
}

function grantCreateRefusal(err: unknown, kind: "READ" | "INTERVENE"): never {
  if (isUniqueViolation(err))
    throw kind === "READ"
      ? new OpsRefusal(
          "READ_ACTIVE",
          "You already have live access to this booking chat.",
        )
      : new OpsRefusal(
          "INTERVENTION_ACTIVE",
          "Familiarise Support is already in this booking chat.",
        );
  throw err;
}

/** Opens a 24-hour READ grant; invisible to the parties until the post-decision notice. */
export const openChatReadDoor = withOpsAction(
  "supportChat.read",
  "support.chat.read.grant",
  OpenChatReadBody.shape,
  {
    mode: "tx",
    run: async (tx, { body, actor, params, opsActionId }) => {
      const now = new Date();
      const supportCase = await loadOpenCase(tx, params);
      const chat = await resolveCaseChat(tx, supportCase);
      const scopeUserIds = scopeFor(chat, body.targetUserIds);
      await endExpiredGrantsTx(
        tx,
        { caseId: supportCase.id, grantedById: actor.userId, kind: "READ" },
        now,
      );
      const grant = await tx.supportCaseChatAccess
        .create({
          data: {
            caseId: supportCase.id,
            kind: "READ",
            basis: "OPEN_CASE",
            grantedById: actor.userId,
            opsActionId,
            channelType: chat.channelType,
            channelId: chat.channelId,
            scopeUserIds,
            windowStart: chat.windowStart,
            organizationIds: chat.organizationIds,
            withholdNotice: body.withholdNotice ?? false,
            expiresAt: new Date(now.getTime() + CHAT_READ_TTL_MS),
            createdAt: now,
          },
          select: GRANT_SELECT,
        })
        .catch((err: unknown) => grantCreateRefusal(err, "READ"));
      await tx.supportCaseEvent.create({
        data: {
          caseId: supportCase.id,
          actorId: actor.userId,
          kind: "CHAT_ACCESS_GRANTED",
          fromValue: "READ",
          toValue: grant.id,
          note: "OPEN_CASE",
          createdAt: now,
        },
      });
      await writeOrgAudit(tx, chat, "READ");
      return {
        target: { kind: "SupportCase", id: supportCase.id },
        correlationId: `support-case:${supportCase.id}`,
        after: {
          grantId: grant.id,
          kind: "READ",
          channelCid: `${chat.channelType}:${chat.channelId}`,
          scopeUserIds,
          windowStart: chat.windowStart.toISOString(),
          expiresAt: grant.expiresAt.toISOString(),
          organizationIds: chat.organizationIds,
          withholdNotice: grant.withholdNotice,
        },
        response: { grant: projectGrant(grant, actor.userId, now) },
        status: 201,
      };
    },
  },
  { stepUp: true },
);

/**
 * Seats Familiarise Support for 24, 72 or 168 hours. The route refuses frozen
 * or missing channels before this runs; the join itself runs after commit and
 * the SLA sweep retries it.
 */
export const startInterventionDoor = withOpsAction(
  "supportChat.intervene",
  "support.chat.intervene.start",
  StartInterventionBody.shape,
  {
    mode: "tx",
    run: async (tx, { body, actor, params, opsActionId }) => {
      const now = new Date();
      const supportCase = await loadOpenCase(tx, params);
      const chat = await resolveCaseChat(tx, supportCase);
      const scopeUserIds = scopeFor(chat, body.targetUserIds);
      const basisSource = interventionBasisSource(
        body.basis,
        await verifiedInterventionBases(tx, supportCase, now),
      );
      const expiredSeats = await endExpiredGrantsTx(
        tx,
        {
          kind: "INTERVENE",
          channelType: chat.channelType,
          channelId: chat.channelId,
        },
        now,
      );
      const grant = await tx.supportCaseChatAccess
        .create({
          data: {
            caseId: supportCase.id,
            kind: "INTERVENE",
            basis: body.basis,
            grantedById: actor.userId,
            opsActionId,
            channelType: chat.channelType,
            channelId: chat.channelId,
            scopeUserIds,
            windowStart: chat.windowStart,
            organizationIds: chat.organizationIds,
            withholdNotice: body.withholdNotice ?? false,
            expiresAt: new Date(now.getTime() + body.durationHours * HOUR_MS),
            createdAt: now,
          },
          select: GRANT_SELECT,
        })
        .catch((err: unknown) => grantCreateRefusal(err, "INTERVENE"));
      await tx.supportCaseEvent.create({
        data: {
          caseId: supportCase.id,
          actorId: actor.userId,
          kind: "CHAT_ACCESS_GRANTED",
          fromValue: "INTERVENE",
          toValue: grant.id,
          note: `${body.basis} (${basisSource.toLowerCase()}), ${body.durationHours}h`,
          createdAt: now,
        },
      });
      await writeOrgAudit(tx, chat, "INTERVENE");
      const bells = await stagePartyBells(
        tx,
        supportCase,
        scopeUserIds,
        INTERVENTION_JOINED_STATUS,
        `chat-intervention:${grant.id}`,
      );
      return {
        target: { kind: "SupportCase", id: supportCase.id },
        correlationId: `support-case:${supportCase.id}`,
        after: {
          grantId: grant.id,
          kind: "INTERVENE",
          basis: body.basis,
          basisSource,
          durationHours: body.durationHours,
          channelCid: `${chat.channelType}:${chat.channelId}`,
          scopeUserIds,
          expiresAt: grant.expiresAt.toISOString(),
          organizationIds: chat.organizationIds,
          withholdNotice: grant.withholdNotice,
        },
        response: { grant: projectGrant(grant, actor.userId, now) },
        status: 201,
        afterCommit: async () => {
          for (const id of expiredSeats) await leaveIntervention(id);
          // Lock first, so no party can remove Support or clear the chat once it is seated.
          await syncSupportBoundary(chat.channelType, chat.channelId);
          await joinIntervention(grant.id);
          await flushNotificationsAfter({ bells }, "support.chat.intervene");
        },
      };
    },
  },
  { stepUp: true },
);

async function endOwnGrant(
  tx: Tx,
  input: {
    params: Record<string, string>;
    grantId: string;
    kind: "READ" | "INTERVENE";
    actorId: string;
  },
) {
  const now = new Date();
  const { caseId } = Params.parse(input.params);
  const grant = await tx.supportCaseChatAccess.findFirst({
    where: {
      id: input.grantId,
      caseId,
      kind: input.kind,
      // A READ is personal; any operator holding the surface may end an intervention.
      ...(input.kind === "READ" ? { grantedById: input.actorId } : {}),
    },
    select: GRANT_SELECT,
  });
  if (!grant)
    throw new OpsRefusal("GRANT_NOT_FOUND", "Chat access not found.", 404);
  if (
    !isLiveGrant(grant, now) ||
    !(await endChatGrantTx(tx, grant, {
      actorId: input.actorId,
      reason: "ENDED_BY_STAFF",
      now,
    }))
  )
    throw new OpsRefusal(
      "GRANT_ENDED",
      "This chat access has already ended.",
      410,
    );
  return { caseId, grant, now };
}

export const endChatReadDoor = withOpsAction(
  "supportChat.read",
  "support.chat.read.end",
  EndChatGrantBody.shape,
  {
    mode: "tx",
    run: async (tx, { body, actor, params }) => {
      const { caseId, grant } = await endOwnGrant(tx, {
        params,
        grantId: body.grantId,
        kind: "READ",
        actorId: actor.userId,
      });
      return {
        target: { kind: "SupportCaseChatAccess", id: grant.id },
        correlationId: `support-case:${caseId}`,
        after: { caseId, grantId: grant.id, endReason: "ENDED_BY_STAFF" },
        response: { grantId: grant.id },
      };
    },
  },
  { stepUp: true },
);

export const endInterventionDoor = withOpsAction(
  "supportChat.intervene",
  "support.chat.intervene.end",
  EndChatGrantBody.shape,
  {
    mode: "tx",
    run: async (tx, { body, actor, params }) => {
      const { caseId, grant } = await endOwnGrant(tx, {
        params,
        grantId: body.grantId,
        kind: "INTERVENE",
        actorId: actor.userId,
      });
      return {
        target: { kind: "SupportCaseChatAccess", id: grant.id },
        correlationId: `support-case:${caseId}`,
        after: { caseId, grantId: grant.id, endReason: "ENDED_BY_STAFF" },
        response: { grantId: grant.id },
        afterCommit: async () => {
          await leaveIntervention(grant.id);
          await syncSupportBoundary(grant.channelType, grant.channelId);
        },
      };
    },
  },
  { stepUp: true },
);
