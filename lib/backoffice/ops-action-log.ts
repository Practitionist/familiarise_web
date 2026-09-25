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
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma, { type Tx } from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import type { BackofficeSurface } from "@/lib/auth/backoffice-permissions";
import { reportSentryError } from "@/lib/observability/report";
import { refusalCode, refusalResponse } from "./ops-refusal";

/** A reason an auditor can read later; five characters rules out "ok"/"fix". */
export const opsReasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters.")
  .max(1000);

export interface OpsActionInput {
  id?: string;
  actorUserId: string;
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

type RouteContext = { params: Promise<Record<string, string>> };

/**
 * The route shell every console door shares: the surface gate, a Zod body
 * with a required `reason`, the handler, the audit row, and typed refusals.
 */
export function withOpsAction<S extends z.ZodRawShape>(
  surface: BackofficeSurface,
  action: string,
  shape: S,
  door: TxDoor<z.infer<z.ZodObject<S>>> | GatewayDoor<z.infer<z.ZodObject<S>>>,
) {
  const schema = z.object(shape).extend({ reason: opsReasonSchema });
  return async (req: NextRequest, route?: RouteContext) => {
    const auth = await requireBackofficeSurface(surface);
    if (auth.error) return auth.error;
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
    const ctx: OpsDoorContext<z.infer<z.ZodObject<S>>> = {
      body: parsed.data as z.infer<z.ZodObject<S>> & { reason: string },
      actor: {
        userId: auth.session.user.id,
        role: String(auth.session.user.role ?? "UNKNOWN"),
      },
      params: route ? await route.params : {},
      opsActionId: randomUUID(),
    };
    const row = (r: OpsDoorResult, after?: Prisma.InputJsonValue) => ({
      id: ctx.opsActionId,
      actorUserId: ctx.actor.userId,
      actorRole: ctx.actor.role,
      surface,
      action,
      targetKind: r.target.kind,
      targetId: r.target.id,
      reason: ctx.body.reason,
      before: r.before,
      after: after ?? r.after,
      correlationId: r.correlationId,
    });
    try {
      const result =
        door.mode === "tx"
          ? await prisma.$transaction(async (tx) => {
              const r = await door.run(tx, ctx);
              await recordOpsAction(tx, row(r));
              return r;
            })
          : await runGatewayDoor(door, ctx, row);
      return NextResponse.json(
        { ...result.response, opsActionId: ctx.opsActionId },
        { status: result.status ?? 200 },
      );
    } catch (err) {
      const refused = refusalResponse(err);
      if (refused) return refused;
      reportSentryError(err, {
        subsystem: "admin",
        op: `ops:${action}`,
        extra: { opsActionId: ctx.opsActionId },
      });
      return NextResponse.json(
        { error: "Something went wrong — please try again.", code: "FAILED" },
        { status: 500 },
      );
    }
  };
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
