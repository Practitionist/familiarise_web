/**
 * #1771 K-1 — every back-office door writes exactly one OpsActionLog row: who,
 * as which role, on which surface, did what to which row, and why.
 *
 * Two shapes. A transactional door runs its handler and the row in ONE
 * transaction, so a rolled-back door leaves no row. A gateway door cannot sit
 * inside a transaction, so its row is written right after the call, carrying
 * `after.status` (SUCCEEDED or FAILED with the refusal code) either way.
 */

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import type { Session } from "@/lib/auth";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { requireFreshSession } from "@/lib/auth/step-up";
import {
  hasBackofficePermission,
  type BackofficeSurface,
} from "@/lib/auth/backoffice-permissions";
import { reportSentryError } from "@/lib/observability/report";
import { scheduleAfter } from "@/lib/api/after-safe";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { UserRoleEnum } from "@/schemas/user";
import { OpsRefusal, refusalCode, refusalResponse } from "./ops-refusal";
import { opsReasonSchema } from "./ops-reason";
import {
  markProposalExecuted,
  openProposal,
  requiresSecondApprover,
} from "./ops-proposals";

export interface OpsActionInput {
  id?: string;
  actorUserId: string | null;
  actorRole: string;
  surface: BackofficeSurface;
  action: string;
  targetKind: string;
  targetId: string;
  reason: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  correlationId?: string | null;
}

/** Writes the one audit row, on the caller's transaction when it has one. */
export async function recordOpsAction(
  db: Pick<Tx, "opsActionLog">,
  input: OpsActionInput,
): Promise<{ id: string }> {
  return db.opsActionLog.create({
    data: {
      id: input.id,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      surface: input.surface,
      action: input.action,
      targetKind: input.targetKind,
      targetId: input.targetId,
      reason: input.reason,
      before: input.before,
      after: input.after,
      correlationId: input.correlationId ?? null,
    },
    select: { id: true },
  });
}

export interface OpsActor {
  userId: string;
  role: string;
}

/** The audited actor of a gated request: its user and the role the session carries. */
export function opsActorOf(session: Session): OpsActor {
  return {
    userId: session.user.id,
    role: String(session.user.role ?? "UNKNOWN"),
  };
}

export interface OpsDoorContext<B> {
  body: B & { reason: string };
  actor: OpsActor;
  params: Record<string, string>;
  /** The audit row's id, known up front so a refund can key on `ops:<id>`. */
  opsActionId: string;
}

export interface OpsDoorResult {
  target: { kind: string; id: string };
  response: Record<string, unknown>;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  correlationId?: string;
  status?: number;
  /**
   * Side effects that must not run if the transaction rolls back (e.g. a
   * failed audit-row write). Scheduled only once the commit resolved.
   */
  afterCommit?: () => unknown;
}

type TxDoor<B> = {
  mode: "tx";
  run: (tx: Tx, ctx: OpsDoorContext<B>) => Promise<OpsDoorResult>;
};
type GatewayDoor<B> = {
  mode: "gateway";
  /** Named before the call so a failed call is still logged against its row. */
  target: (ctx: OpsDoorContext<B>) => { kind: string; id: string };
  run: (ctx: OpsDoorContext<B>) => Promise<OpsDoorResult>;
};

// Next's route validator passes { params: Promise<ParamMap[route]> }; a
// Promise<unknown> accepts every route's params, read below as strings.
type RouteContext = { params: Promise<unknown> };

type OpsRouteHandler = (
  req: NextRequest,
  route: RouteContext,
) => Promise<NextResponse>;

/** F10: a door whose amount can exceed the threshold names how to price and target it. */
export interface SecondApprover<B> {
  /** The door's route; the approve door dispatches a stored proposal on it. */
  route: string;
  target: (ctx: OpsDoorContext<B>) => { kind: string; id: string };
  /** What the door would move, in paise; Infinity when unbounded. */
  amountPaise: (
    body: B & { reason: string },
    ctx: OpsDoorContext<B>,
  ) => number | Promise<number>;
}

interface OpsActionOptions<B> {
  /** IAM and money doors also need a session re-authenticated within 15 minutes. */
  stepUp?: boolean;
  secondApprover?: SecondApprover<B>;
}

/** A proposal another ADMIN approved, replayed through its own door. */
export interface ApprovedProposal {
  id: string;
  action: string;
  requestBody: Prisma.JsonValue;
  routeParams: Prisma.JsonValue;
  proposedById: string | null;
}

export interface ProposableOpsDoor {
  proposalRoute: string;
  executeApproved: (input: {
    proposal: ApprovedProposal;
    actor: OpsActor;
  }) => Promise<{ opsActionId: string; response: Record<string, unknown> }>;
}

type Body<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;
type Door<B> = TxDoor<B> | GatewayDoor<B>;

const routeParamsSchema = z.record(z.string());

/**
 * The route shell every console door shares: the surface gate, a Zod body
 * with a required `reason`, the handler, the audit row, and typed refusals.
 * With `secondApprover`, an amount above the threshold is held for another ADMIN.
 */
export function withOpsAction<S extends z.ZodRawShape>(
  surface: BackofficeSurface,
  actionOf: string | ((body: Body<S>) => string),
  shape: S,
  door: Door<Body<S>>,
  options: OpsActionOptions<Body<S>> & {
    secondApprover: SecondApprover<Body<S>>;
  },
): OpsRouteHandler & ProposableOpsDoor;
export function withOpsAction<S extends z.ZodRawShape>(
  surface: BackofficeSurface,
  /** A fixed name, or one read off the body (approve vs reject). */
  actionOf: string | ((body: Body<S>) => string),
  shape: S,
  door: Door<Body<S>>,
  options?: OpsActionOptions<Body<S>>,
): OpsRouteHandler;
export function withOpsAction<S extends z.ZodRawShape>(
  surface: BackofficeSurface,
  actionOf: string | ((body: Body<S>) => string),
  shape: S,
  door: Door<Body<S>>,
  options: OpsActionOptions<Body<S>> = {},
): OpsRouteHandler | (OpsRouteHandler & ProposableOpsDoor) {
  const schema = z.object(shape).extend({ reason: opsReasonSchema });
  type Ctx = OpsDoorContext<Body<S>>;
  const actionFor = (body: Body<S>) =>
    typeof actionOf === "string" ? actionOf : actionOf(body);

  /** Runs the door and writes its audit row; a replayed proposal is linked and marked EXECUTED. */
  const execute = async (
    ctx: Ctx,
    action: string,
    proposal?: ApprovedProposal,
  ): Promise<OpsDoorResult> => {
    const link = proposal
      ? { proposalId: proposal.id, proposedById: proposal.proposedById }
      : null;
    const row = (r: OpsDoorResult, after?: Prisma.InputJsonValue) => {
      const base = after ?? r.after;
      return {
        id: ctx.opsActionId,
        actorUserId: ctx.actor.userId,
        actorRole: ctx.actor.role,
        surface,
        action,
        targetKind: r.target.kind,
        targetId: r.target.id,
        reason: ctx.body.reason,
        before: r.before,
        after: link ? { ...(isJsonObject(base) ? base : {}), ...link } : base,
        correlationId: r.correlationId,
      };
    };
    let result: OpsDoorResult;
    if (door.mode === "tx") {
      result = await prisma.$transaction(async (tx) => {
        const r = await door.run(tx, ctx);
        await recordOpsAction(tx, row(r));
        if (
          proposal &&
          (await markProposalExecuted(tx, proposal.id, ctx.opsActionId)) !== 1
        ) {
          throw new OpsRefusal(
            "PROPOSAL_DECIDED",
            "This proposal is no longer approved.",
          );
        }
        return r;
      });
    } else {
      result = await runGatewayDoor(door, ctx, row);
      // The money already moved; a lost EXECUTED mark pages rather than failing the answer.
      if (proposal) {
        await markProposalExecuted(prisma, proposal.id, ctx.opsActionId).catch(
          (err: unknown) =>
            reportSentryError(err, { subsystem: "admin", op: "ops-proposal" }),
        );
      }
    }
    if (result.afterCommit) {
      void scheduleAfter(result.afterCommit, `ops:${action}`);
    }
    return result;
  };

  const failed = (err: unknown, action: string, opsActionId: string) => {
    const refused = refusalResponse(err);
    if (refused) return refused;
    reportSentryError(err, {
      subsystem: "admin",
      op: `ops:${action}`,
      extra: { opsActionId },
    });
    return NextResponse.json(
      { error: "Something went wrong — please try again.", code: "FAILED" },
      { status: 500 },
    );
  };

  const handler: OpsRouteHandler = async (req, route) => {
    const auth = await requireBackofficeSurface(surface, { expectUser: true });
    if (auth.error) return auth.error;
    if (options.stepUp) {
      const stale = requireFreshSession(auth.session);
      if (stale) return stale;
    }
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: parsed.error.issues[0]?.message ?? "Invalid request",
          code: "INVALID_BODY",
        },
        { status: 400 },
      );
    }
    const ctx: Ctx = {
      body: parsed.data as Body<S> & { reason: string },
      actor: opsActorOf(auth.session),
      params:
        ((await route?.params) as Record<string, string> | undefined) ?? {},
      opsActionId: randomUUID(),
    };
    const action = actionFor(ctx.body);
    try {
      if (options.secondApprover) {
        const proposed = await proposeIfRequired(
          options.secondApprover,
          surface,
          action,
          ctx,
        );
        if (proposed) {
          return NextResponse.json(
            {
              proposalId: proposed.id,
              status: "PROPOSED",
              expiresAt: proposed.expiresAt.toISOString(),
              opsActionId: ctx.opsActionId,
            },
            { status: 202 },
          );
        }
      }
      const result = await execute(ctx, action);
      return NextResponse.json(
        { ...result.response, opsActionId: ctx.opsActionId },
        { status: result.status ?? 200 },
      );
    } catch (err) {
      return failed(err, action, ctx.opsActionId);
    }
  };

  const secondApprover = options.secondApprover;
  if (!secondApprover) return handler;
  const executeApproved: ProposableOpsDoor["executeApproved"] = async ({
    proposal,
    actor,
  }) => {
    const role = UserRoleEnum.safeParse(actor.role);
    if (!role.success || !hasBackofficePermission(role.data, surface)) {
      throw new OpsRefusal(
        "FORBIDDEN",
        "You cannot run this action yourself, so you cannot approve it.",
        403,
      );
    }
    const body = schema.safeParse(proposal.requestBody);
    const params = routeParamsSchema.safeParse(proposal.routeParams);
    if (!body.success || !params.success) {
      throw new OpsRefusal(
        "PROPOSAL_INVALID",
        "This proposal's stored request no longer validates; propose it again.",
      );
    }
    const ctx: Ctx = {
      body: body.data as Body<S> & { reason: string },
      actor,
      params: params.data,
      opsActionId: randomUUID(),
    };
    const action = actionFor(ctx.body);
    if (action !== proposal.action) {
      throw new OpsRefusal(
        "PROPOSAL_INVALID",
        "This proposal's stored request names a different action.",
      );
    }
    const result = await execute(ctx, action, proposal);
    return { opsActionId: ctx.opsActionId, response: result.response };
  };
  return Object.assign(handler, {
    proposalRoute: secondApprover.route,
    executeApproved,
  });
}

/** Holds the door as a PROPOSED row when F10 needs a second ADMIN; null runs it now. */
async function proposeIfRequired<B>(
  secondApprover: SecondApprover<B>,
  surface: BackofficeSurface,
  action: string,
  ctx: OpsDoorContext<B>,
): Promise<{ id: string; expiresAt: Date } | null> {
  const amountPaise = await secondApprover.amountPaise(ctx.body, ctx);
  if (!(await requiresSecondApprover(prisma, amountPaise))) return null;
  const target = secondApprover.target(ctx);
  // A JSON round-trip, not a clone: the row holds exactly what the replay re-parses.
  const requestBody: Prisma.InputJsonValue = JSON.parse(
    JSON.stringify(ctx.body),
  );
  try {
    return await prisma.$transaction(async (tx) => {
      const proposal = await openProposal(tx, {
        action,
        route: secondApprover.route,
        target,
        amountPaise,
        requestBody,
        routeParams: ctx.params,
        proposedById: ctx.actor.userId,
        reason: ctx.body.reason,
        now: new Date(),
      });
      await recordOpsAction(tx, {
        id: ctx.opsActionId,
        actorUserId: ctx.actor.userId,
        actorRole: ctx.actor.role,
        surface,
        action: "ops-proposal.propose",
        targetKind: target.kind,
        targetId: target.id,
        reason: ctx.body.reason,
        after: {
          proposalId: proposal.id,
          action,
          amountPaise: Number.isFinite(amountPaise) ? amountPaise : null,
        },
      });
      return proposal;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new OpsRefusal(
        "PROPOSAL_PENDING",
        "This action is already waiting for a second admin's approval.",
      );
    }
    throw err;
  }
}

async function runGatewayDoor<B>(
  door: GatewayDoor<B>,
  ctx: OpsDoorContext<B>,
  row: (r: OpsDoorResult, after?: Prisma.InputJsonValue) => OpsActionInput,
): Promise<OpsDoorResult> {
  const target = door.target(ctx);
  let result: OpsDoorResult;
  try {
    result = await door.run(ctx);
  } catch (err) {
    // The call may have moved money before it threw; the row says it was tried.
    await recordOpsAction(
      prisma,
      row(
        { target, response: {} },
        { status: "FAILED", code: refusalCode(err) },
      ),
    ).catch((logErr: unknown) =>
      reportSentryError(logErr, { subsystem: "admin", op: "ops-log" }),
    );
    throw err;
  }
  const after = {
    status: "SUCCEEDED",
    ...(isJsonObject(result.after) ? result.after : {}),
  };
  // The money already moved; a lost audit row pages rather than failing the answer.
  await recordOpsAction(prisma, row(result, after)).catch((logErr: unknown) =>
    reportSentryError(logErr, { subsystem: "admin", op: "ops-log" }),
  );
  return result;
}

function isJsonObject(v: unknown): v is Prisma.InputJsonObject {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
