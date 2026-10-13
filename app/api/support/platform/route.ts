/**
 * #support-hub — PLATFORM-scope support intake (stateless).
 *
 * Platform issues (account, payments, site technical, general, operator
 * billing) have no appointment to hang a thread on. The flowchart runs
 * STATELESSLY: the client holds the cursor and replays it each turn; the
 * server validates every transition against the platform registry and never
 * trusts client state beyond "which node are you on". A terminal either
 * self-serves (nothing persisted) or escalates — the only write, a
 * SupportTicket via the shared factory with the walked path summarized in.
 *
 * GET  → the intent catalog for this caller (chips for the intake sheet).
 * POST → advance one turn: {flowId, nodeId?, chosenOptionId?/userMessage, orgId?}.
 *
 * Auth: any signed-in user (all roles — consultee, consultant, org operator).
 * Rate limit: same spam limiter as ticket creation, since escalation IS
 * ticket creation.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import { supportError } from "@/lib/api/support-http";
import { spamLimiter, applyRateLimit } from "@/lib/rate-limit";
import { assertBodySize } from "@/lib/validation/limits";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import prisma from "@/lib/prisma";
import { walkFlow } from "@/lib/support/flow-walk";
import {
  platformFlowsForContext,
  platformFlowForId,
  issueTypeForFlow,
  resolveOrgAttribution,
  type PlatformSupportContext,
} from "@/lib/support/platform-flows";
import {
  createSupportTicket,
  findRecentOpenEscalation,
  raiseReusedTicketToHigh,
} from "@/lib/support/create-ticket";
import { escalationPriority } from "@/lib/support/priority";
import { recordFlowOutcome } from "@/lib/support/deflection";
import {
  escalationBrief,
  isBareHumanRequest,
  mentionsHumanKeyword,
} from "@/lib/support/escalation";

const turnSchema = z
  .object({
    flowId: z.string().min(1).max(64),
    /** Client-held cursor; null/omitted = first turn (entry prompt). */
    nodeId: z.string().max(64).nullable().optional(),
    chosenOptionId: z.string().max(200).optional(),
    userMessage: z.string().trim().max(2000).optional(),
    /** Org attribution for operator flows — validated against membership. */
    orgId: z.string().max(64).optional(),
    /** The customer flagged the hand-off as urgent. */
    urgent: z.boolean().optional(),
    /** Visited node IDs replayed from client state; resolved strictly against server registry. */
    visitedNodeIds: z.array(z.string().max(64)).max(8).optional(),
  })
  .refine((v) => !(v.chosenOptionId && v.userMessage), {
    message: "Send either a chosen option or a message, not both",
  });

type TurnInput = z.infer<typeof turnSchema>;
type PlatformFlow = NonNullable<ReturnType<typeof platformFlowForId>>;
type WalkResult = ReturnType<typeof walkFlow>;

function resolveCandidateIds(
  entryNodeId: string,
  visitedNodeIds: readonly string[] | undefined,
  currentNodeId: string | null | undefined,
): readonly string[] {
  if (visitedNodeIds && visitedNodeIds.length > 0) return visitedNodeIds;
  if (currentNodeId) return [entryNodeId, currentNodeId];
  return [entryNodeId];
}

function stepLabelFromNodes(
  flow: PlatformFlow,
  id: string,
  prevId: string | null,
): string | null {
  if (prevId) {
    const prevNode = flow.nodes[prevId];
    if (prevNode?.kind === "PROMPT") {
      const matchedOpt = prevNode.options.find((o) => o.next === id);
      if (matchedOpt) return matchedOpt.label;
    }
  }
  if (id !== flow.entryNodeId) {
    const node = flow.nodes[id];
    const snippet = node?.body.split(/[.?!]/)[0]?.trim();
    if (snippet) return snippet;
  }
  return null;
}

/** Resolve visited node IDs strictly from the server flow graph into human-readable steps. */
function buildServerPlatformPath(
  flow: PlatformFlow,
  visitedNodeIds: readonly string[] | undefined,
  currentNodeId: string | null | undefined,
  chosenLabel: string | undefined,
): string {
  const candidateIds = resolveCandidateIds(
    flow.entryNodeId,
    visitedNodeIds,
    currentNodeId,
  );
  const validIds: string[] = [];
  for (const id of candidateIds) {
    if (flow.nodes[id] && !validIds.includes(id)) {
      validIds.push(id);
    }
  }

  const steps: string[] = [flow.title];
  for (let i = 0; i < validIds.length; i += 1) {
    const step = stepLabelFromNodes(
      flow,
      validIds[i],
      i > 0 ? validIds[i - 1] : null,
    );
    if (step && !steps.includes(step)) {
      steps.push(step);
    }
  }
  if (chosenLabel && !steps.includes(chosenLabel)) {
    steps.push(chosenLabel);
  }
  return steps.join(" → ");
}

function extractTerminalNodeId(
  messages: WalkResult["messages"],
): string | null {
  const meta = messages[0]?.metadata;
  if (
    typeof meta === "object" &&
    meta !== null &&
    "nodeId" in meta &&
    typeof meta.nodeId === "string"
  ) {
    return meta.nodeId;
  }
  return null;
}

/** Resolve the caller's platform context (role-aware intent gating). */
async function buildPlatformContext(
  userId: string,
): Promise<PlatformSupportContext> {
  const memberships = await prisma.membership.findMany({
    where: { userId, status: "ACTIVE" },
    select: { organizationId: true, role: true },
  });
  return {
    userId,
    isOperator: memberships.some((m) =>
      hasOrgPermission(m.role, "operations.read"),
    ),
    organizationIds: memberships.map((m) => m.organizationId),
  };
}

async function handleSelfServeTurn(
  flow: PlatformFlow,
  turn: WalkResult,
  userId: string,
  organizationId: string | null,
): Promise<NextResponse> {
  const outcomeId = turn.resolved
    ? await recordFlowOutcome({
        scope: "PLATFORM",
        flowKey: flow.id,
        terminalNodeId: extractTerminalNodeId(turn.messages),
        reason: turn.reason ?? null,
        outcome: "RESOLVED",
        userId,
        organizationId,
      })
    : null;

  return NextResponse.json({
    data: {
      flowId: flow.id,
      messages: turn.messages,
      nextNodeId: turn.nextNodeId,
      resolved: turn.resolved,
      escalated: false,
      actions: turn.actions,
      outcomeId,
    },
  });
}

async function handleEscalatedTurn(
  flow: PlatformFlow,
  turn: WalkResult,
  input: TurnInput,
  userId: string,
  organizationId: string | null,
): Promise<NextResponse> {
  const rl = await applyRateLimit(spamLimiter, `tickets:${userId}`);
  if (rl) return rl;

  const reason = turn.reason ?? "platform_escalated";
  const issueType = issueTypeForFlow(flow, reason);
  const priority = escalationPriority(reason, input.urgent);

  const terminalNodeId = extractTerminalNodeId(turn.messages);
  const terminalNode = terminalNodeId ? flow.nodes[terminalNodeId] : undefined;
  const terminalPromises =
    turn.promises ??
    (terminalNode?.kind === "TERMINAL" ? terminalNode.promises : undefined);

  const typedAsk =
    input.userMessage && !isBareHumanRequest(input.userMessage)
      ? input.userMessage
      : (turn.chosenLabel ?? null);

  const brief = escalationBrief({
    customerAsk: typedAsk,
    topic: flow.title,
    path: buildServerPlatformPath(
      flow,
      input.visitedNodeIds,
      input.nodeId,
      turn.chosenLabel,
    ),
    botSaid: turn.messages.find((m) => m.sender === "BOT")?.body ?? null,
    reason,
    promises: terminalPromises,
  });
  const description = organizationId
    ? `${brief}\nOrganization: ${organizationId}`
    : brief;

  const recent = await findRecentOpenEscalation(
    userId,
    issueType,
    organizationId,
  );
  if (recent) {
    if (input.urgent) await raiseReusedTicketToHigh(prisma, recent.id);
    const recentTicket = await prisma.supportTicket.findUnique({
      where: { id: recent.id },
      select: { ackDueAt: true },
    });
    return NextResponse.json({
      data: {
        flowId: flow.id,
        messages: turn.messages,
        nextNodeId: null,
        resolved: false,
        escalated: true,
        actions: turn.actions,
        supportTicketId: recent.id,
        supportTicketReference: recent.referenceNumber,
        replyByAt: recentTicket?.ackDueAt?.toISOString() ?? null,
        deduped: true,
      },
    });
  }

  const ticket = await createSupportTicket({
    userId,
    title: `${flow.title}: ${reason.replaceAll("_", " ").toLowerCase()}`,
    description,
    priority,
    issueType,
    organizationId,
    filedBy: "requester",
  });

  await recordFlowOutcome({
    scope: "PLATFORM",
    flowKey: flow.id,
    terminalNodeId,
    reason,
    outcome: "ESCALATED",
    userId,
    organizationId,
  });

  return NextResponse.json({
    data: {
      flowId: flow.id,
      messages: turn.messages,
      nextNodeId: null,
      resolved: false,
      escalated: true,
      actions: turn.actions,
      supportTicketId: ticket.id,
      supportTicketReference: ticket.referenceNumber,
      replyByAt: ticket.ackDueAt?.toISOString() ?? null,
    },
  });
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }
    const ctx = await buildPlatformContext(session.user.id);
    const flows = platformFlowsForContext(ctx).map((f) => ({
      id: f.id,
      title: f.title,
      description: f.description,
    }));
    return NextResponse.json({ data: { flows } });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: "support.platform", action: "catalog" },
    });
  }
}

export async function POST(req: NextRequest) {
  let userId: string | null = null;
  let flowId: string | null = null;
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }
    userId = session.user.id;

    const tooLarge = assertBodySize(req);
    if (tooLarge) return tooLarge;

    const body = turnSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: body.error.flatten(),
        context: { route: "support.platform", action: "turn" },
      });
    }
    const input = body.data;
    flowId = input.flowId;

    const ctx = await buildPlatformContext(session.user.id);
    const flow = platformFlowForId(ctx, input.flowId);
    if (!flow) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "That support topic isn't available — refresh and pick again.",
        detail: { flowId: input.flowId },
        context: { route: "support.platform", action: "turn" },
      });
    }

    const walked = walkFlow(
      flow,
      input.nodeId ?? null,
      { chosenOptionId: input.chosenOptionId, userMessage: input.userMessage },
      { refundPctIfCancelledNow: null },
    );
    const turn =
      mentionsHumanKeyword(input.userMessage) ||
      input.chosenOptionId === "human"
        ? {
            ...walked,
            escalate: true,
            resolved: false,
            reason: walked.reason ?? "general_human",
          }
        : walked;

    const attribution = resolveOrgAttribution({
      flowId: flow.id,
      requestedOrgId: input.orgId,
      activeOrganizationIds: ctx.organizationIds,
    });
    if (!attribution.ok) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        context: {
          route: "support.platform",
          action: "turn",
          flowId: flow.id,
          attemptedOrgId: input.orgId,
        },
      });
    }

    if (!turn.escalate) {
      return handleSelfServeTurn(
        flow,
        turn,
        session.user.id,
        attribution.organizationId,
      );
    }

    return handleEscalatedTurn(
      flow,
      turn,
      input,
      session.user.id,
      attribution.organizationId,
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: {
        route: "support.platform",
        action: "turn",
        userId,
        flowId,
      },
    });
  }
}
