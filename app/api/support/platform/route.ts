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
  type PlatformSupportContext,
} from "@/lib/support/platform-flows";
import { createSupportTicket } from "@/lib/support/create-ticket";
import { priorityForReason } from "@/lib/support/priority";

const turnSchema = z
  .object({
    flowId: z.string().min(1).max(64),
    /** Client-held cursor; null/omitted = first turn (entry prompt). */
    nodeId: z.string().max(64).nullable().optional(),
    chosenOptionId: z.string().max(200).optional(),
    userMessage: z.string().trim().max(2000).optional(),
    /** Org attribution for operator flows — validated against membership. */
    orgId: z.string().max(64).optional(),
  })
  // Only BOTH is invalid. An entry turn (nodeId null/omitted) legitimately
  // carries neither — startFlow sends {flowId} alone, and the XOR refinement
  // this replaced 400'd exactly that, breaking every intake's first click.
  .refine((v) => !(v.chosenOptionId && v.userMessage), {
    message: "Send either a chosen option or a message, not both",
  });

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
  // Hoisted so the catch block can tag the Sentry event even when the throw
  // happened before/during parsing.
  let userId: string | null = null;
  let flowId: string | null = null;
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return supportError({ status: 401, code: "UNAUTHORIZED" });
    }
    userId = session.user.id;

    // Escalation creates a ticket — same spam budget as the legacy form.
    const rl = await applyRateLimit(spamLimiter, `tickets:${session.user.id}`);
    if (rl) return rl;

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
    // An unavailable flow (e.g. operator-only, or stale catalog) 404s rather
    // than silently escalating — the client should refetch the catalog.
    if (!flow) {
      return supportError({
        status: 404,
        code: "NOT_FOUND",
        message: "That support topic isn't available — refresh and pick again.",
        detail: { flowId: input.flowId },
        context: { route: "support.platform", action: "turn" },
      });
    }

    const turn = walkFlow(
      flow,
      input.nodeId ?? null,
      { chosenOptionId: input.chosenOptionId, userMessage: input.userMessage },
      // Platform scope has no cancellation preview — refund % stays null.
      { refundPctIfCancelledNow: null },
    );

    if (!turn.escalate) {
      return NextResponse.json({
        data: {
          flowId: flow.id,
          messages: turn.messages,
          nextNodeId: turn.nextNodeId,
          resolved: turn.resolved,
          escalated: false,
          actions: turn.actions,
        },
      });
    }

    // ---- Escalation: the only write. Summarize the walked path + free text
    // into the ticket so ops sees the flow's conclusions, not just a title.
    const reason = turn.reason ?? "platform_escalated";
    const issueType = issueTypeForFlow(flow, reason);
    const priority = priorityForReason(reason);

    // Operator org attribution — only an org the caller is an ACTIVE member
    // of, never a client-asserted id.
    let organizationId: string | null = null;
    if (input.orgId && ctx.organizationIds.includes(input.orgId)) {
      organizationId = input.orgId;
    } else if (!input.orgId && ctx.organizationIds.length === 1) {
      organizationId = ctx.organizationIds[0];
    }

    const walkedPath = input.nodeId
      ? `Flow ${flow.id} at node ${input.nodeId}`
      : `Flow ${flow.id} entry`;
    const description = [
      `Escalated from platform support intake (${flow.title}, reason: ${reason}).`,
      input.userMessage ? `User said: "${input.userMessage}"` : null,
      `[${walkedPath}]`,
      organizationId ? `Organization: ${organizationId}` : null,
    ]
      .filter(Boolean)
      .join(" ");

    // Payment dedup parity with the legacy form (findOpenTicketForPayment)
    // applies when the intake gains a paymentId selector — the escalation
    // seam above is the single place to add it.

    const ticket = await createSupportTicket({
      userId: session.user.id,
      title: `${flow.title}: ${reason.replaceAll("_", " ").toLowerCase()}`,
      description,
      priority,
      issueType,
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
      },
    });
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
