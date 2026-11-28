/**
 * Refund discovery: lists the refunds the gateway created since the job's
 * checkpoint and hands each one the database does not hold to the refund
 * webhook's own handler. It crosses the vendor boundary: only the gateway knows
 * of a refund made in its dashboard or one whose webhook never arrived.
 */

import { RefundStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import type { ConfigSkip } from "@/lib/cron/config-skip";
import {
  getRazorpayClient,
  listRazorpayRefundsCreatedBetween,
  withRazorpaySdkTimeout,
} from "@/lib/payments/core/razorpay";
import { mapGatewayRefundStatus } from "@/lib/payments/refund-status";
import {
  errorMessageOf,
  reportSentryMessage,
} from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import type { RazorpayListedRefund } from "@/schemas/webhooks/razorpay";
import {
  CUT_RUNS_BEFORE_FINDING,
  DEFERRED_KEEP_SECONDS,
  DEFERRED_RETRY_SECONDS,
  gatewayReadTurn,
  MAX_REMEMBERED_DEFERRALS,
  readDiscoveryState,
  type DiscoveryStoppedShort,
} from "./checkpoint";

/** The lock name of the job that runs this pass; its run rows keep the position. */
const REFUND_DISCOVERY_JOB = "reconcile-pending-refunds";

/** The gateway's largest page. */
const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 3;
/**
 * Each window starts this far behind the last one's end, so a refund the list
 * did not show yet, or one whose capture was recorded late, is read again.
 */
const OVERLAP_SECONDS = 24 * 60 * 60;
const FIRST_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

/**
 * `since` is the end of the last window read to its last page. `window` is one
 * still being paged: its bounds stay fixed so `skip` keeps its meaning across
 * runs. `cutRuns` counts runs in a row that a bound ended. `deferred` are
 * refunds the handler deferred, with when the gateway created each and when it
 * was last tried: the next window opens no later than the oldest of them.
 */
const stateSchema = z.object({
  since: z.number().int().positive().nullable(),
  window: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().positive(),
      skip: z.number().int().nonnegative(),
    })
    .nullable(),
  cutRuns: z.number().int().nonnegative(),
  deferred: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.number().int().positive(),
        triedAt: z.number().int(),
      }),
    )
    .max(MAX_REMEMBERED_DEFERRALS)
    .default([]),
});
type DiscoveryState = z.infer<typeof stateSchema>;

/** `payments.fetch`, read only for the order and whether the payment was captured. */
const listedRefundPaymentSchema = z
  .object({
    order_id: z.string().nullable().optional(),
    captured: z.boolean().optional(),
  })
  .passthrough();

export interface RefundDiscoveryRun {
  /** Set when the pass did not run. */
  skipped?: ConfigSkip;
  /** Refunds the gateway returned in this run. */
  listed: number;
  /** Refunds that have a row now and had none before the hand-over. */
  imported: number;
  alreadyKnown: number;
  /** Refunds the handler deferred in this run: no payment, top-up or invoice holds their payment, or its capture is not recorded. */
  unknownPayment: number;
  /** Remembered deferrals passed over with no hand-over: not due for a retry yet, or past the run's bound on gateway reads. */
  waiting: number;
  /** Deferred refunds that no longer hold the window: created over 7 days ago, or met when no further deferral could be remembered. */
  notHeld: number;
  /** Refunds the gateway lists as failed; never handed over, so this pass fails nothing. */
  gatewayFailed: number;
  /** Refunds the handler took without writing a Refund row: a top-up or invoice refund, or one it refused. */
  noRefundRow: number;
  errors: string[];
  stoppedShort: DiscoveryStoppedShort | null;
  /** The position the next run resumes from; absent when the pass did not run. */
  checkpoint?: string;
}

type HandOver = "imported" | "unknown-payment" | "no-refund-row";

/**
 * Hands one listed refund to the webhook's handler with what its event would
 * have carried. `localOrderId` is the order of the payment row that holds the
 * refunded capture id; without one the gateway is read for it.
 */
async function handOver(
  listed: RazorpayListedRefund,
  localOrderId: string | undefined,
): Promise<HandOver> {
  let orderId = localOrderId ?? listed.payment_id;
  let captured: boolean | undefined;
  const client = localOrderId ? null : getRazorpayClient();
  if (client) {
    const fetched = listedRefundPaymentSchema.parse(
      await withRazorpaySdkTimeout("payments.fetch", () =>
        client.payments.fetch(listed.payment_id),
      ),
    );
    if (fetched.order_id) orderId = fetched.order_id;
    captured = fetched.captured;
  }

  const { handleRefundCreated, DeferSignal } =
    await import("@/app/api/webhooks/utils");
  const result = await handleRefundCreated(
    listed.id,
    orderId,
    listed.amount,
    listed.currency || "INR",
    listed.status,
    listed.payment_id,
    listed.notes,
    captured,
  );
  if (result instanceof DeferSignal) return "unknown-payment";
  const row = await prisma.refund.findUnique({
    where: { refundId: listed.id },
    select: { id: true },
  });
  return row ? "imported" : "no-refund-row";
}

/**
 * One bounded pass. The position moves past a page when every refund on it was
 * handed over or passed over as a remembered deferral, and past a window only
 * at its last page. A refund the handler defers is remembered, and holds the
 * next window open back to its creation until it is imported or 7 days old.
 */
export async function discoverGatewayRefunds(
  outOfTime: () => boolean,
  now: Date = new Date(),
): Promise<RefundDiscoveryRun> {
  const run: RefundDiscoveryRun = {
    listed: 0,
    imported: 0,
    alreadyKnown: 0,
    unknownPayment: 0,
    waiting: 0,
    notHeld: 0,
    gatewayFailed: 0,
    noRefundRow: 0,
    errors: [],
    stoppedShort: null,
  };
  if (!getRazorpayClient()) {
    return {
      ...run,
      skipped: "RAZORPAY_KEY_ID or RAZORPAY_SECRET not configured",
    };
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const state: DiscoveryState = (await readDiscoveryState(
    REFUND_DISCOVERY_JOB,
    stateSchema,
  )) ?? { since: null, window: null, cutRuns: 0, deferred: [] };
  const remembered = new Map(
    state.deferred.map(({ id, ...entry }) => [id, entry]),
  );
  // One second earlier, whether or not the gateway's `from` is inclusive.
  const oldestDeferred = Math.min(
    ...state.deferred.map((entry) => entry.createdAt - 1),
  );
  const window = state.window ?? {
    from: Math.min(
      state.since === null
        ? nowSeconds - FIRST_LOOKBACK_SECONDS
        : state.since - OVERLAP_SECONDS,
      oldestDeferred,
    ),
    to: nowSeconds,
    skip: 0,
  };

  const unknownPayment: string[] = [];
  const waiting: string[] = [];
  const notHeld: string[] = [];
  let gatewayReadTries = 0;
  let skip = window.skip;
  let pagesHandled = 0;
  let windowDone = false;

  while (!windowDone) {
    if (outOfTime()) {
      run.stoppedShort = { bound: "deadline", pagesHandled };
      break;
    }
    if (pagesHandled >= MAX_PAGES_PER_RUN) {
      run.stoppedShort = { bound: "pages", pagesHandled };
      break;
    }
    let page: RazorpayListedRefund[];
    try {
      page = await listRazorpayRefundsCreatedBetween(
        { from: window.from, to: window.to },
        PAGE_SIZE,
        skip,
      );
    } catch (error) {
      run.errors.push(`Refund list: ${errorMessageOf(error)}`);
      break;
    }
    run.listed += page.length;

    const known = new Set(
      (
        await prisma.refund.findMany({
          where: { refundId: { in: page.map((refund) => refund.id) } },
          select: { refundId: true },
        })
      ).map((row) => row.refundId),
    );
    const unseen = page.filter((refund) => !known.has(refund.id));
    const localOrders = new Map(
      unseen.length === 0
        ? []
        : (
            await prisma.payment.findMany({
              where: {
                gatewayPaymentId: { in: unseen.map((r) => r.payment_id) },
              },
              select: { gatewayPaymentId: true, paymentIntent: true },
            })
          ).map((row) => [row.gatewayPaymentId, row.paymentIntent]),
    );
    let pageFailed = false;
    let cutInPage = false;
    for (const listed of page) {
      if (known.has(listed.id)) {
        run.alreadyKnown++;
        remembered.delete(listed.id);
        continue;
      }
      if (mapGatewayRefundStatus(listed.status) === RefundStatus.FAILED) {
        run.gatewayFailed++;
        remembered.delete(listed.id);
        continue;
      }
      const localOrderId = localOrders.get(listed.payment_id);
      if (localOrderId === undefined) {
        const turn = gatewayReadTurn(
          remembered,
          listed.id,
          {
            createdAt: listed.created_at,
            triedAt: nowSeconds - DEFERRED_RETRY_SECONDS,
          },
          nowSeconds,
          gatewayReadTries,
        );
        if (turn !== "try") {
          (turn === "wait" ? waiting : notHeld).push(listed.id);
          continue;
        }
      }
      if (outOfTime()) {
        cutInPage = true;
        break;
      }
      try {
        if (localOrderId === undefined) gatewayReadTries++;
        const outcome = await handOver(listed, localOrderId);
        if (outcome !== "unknown-payment") {
          remembered.delete(listed.id);
          if (outcome === "imported") run.imported++;
          else run.noRefundRow++;
          continue;
        }
        unknownPayment.push(listed.id);
        if (
          remembered.has(listed.id) ||
          remembered.size < MAX_REMEMBERED_DEFERRALS
        ) {
          remembered.set(listed.id, {
            createdAt: listed.created_at,
            triedAt: nowSeconds,
          });
        } else {
          notHeld.push(listed.id);
        }
      } catch (error) {
        pageFailed = true;
        run.errors.push(`Refund ${listed.id}: ${errorMessageOf(error)}`);
      }
    }
    if (cutInPage) {
      run.stoppedShort = { bound: "deadline", pagesHandled };
      break;
    }
    if (pageFailed) break;
    pagesHandled++;
    skip += page.length;
    windowDone = page.length < PAGE_SIZE;
  }

  if (windowDone) {
    // A deferral this old stops holding the window: the webhook sweep gives up at the same age.
    for (const [id, entry] of remembered) {
      if (entry.createdAt > window.to - DEFERRED_KEEP_SECONDS) continue;
      remembered.delete(id);
      notHeld.push(id);
    }
  }
  run.unknownPayment = unknownPayment.length;
  run.waiting = waiting.length;
  run.notHeld = notHeld.length;
  const deferred = [...remembered].map(([id, entry]) => ({ id, ...entry }));
  const next: DiscoveryState = windowDone
    ? { since: window.to, window: null, cutRuns: 0, deferred }
    : {
        since: state.since,
        window: { ...window, skip },
        cutRuns: run.stoppedShort ? state.cutRuns + 1 : state.cutRuns,
        deferred,
      };
  run.checkpoint = JSON.stringify(next);

  await reportDiscoveryFindings(
    [...unknownPayment, ...waiting],
    notHeld,
    run.stoppedShort,
    next,
  );
  return run;
}

/** Once per run: the refunds the handler deferred, the ones no longer retried, and a pass a bound keeps cutting. */
async function reportDiscoveryFindings(
  unknownPayment: string[],
  notHeld: string[],
  stoppedShort: DiscoveryStoppedShort | null,
  next: DiscoveryState,
): Promise<void> {
  if (unknownPayment.length > 0) {
    const message = `Refund discovery: ${unknownPayment.length} gateway refund(s) are on a payment the database does not hold as captured; nothing was written for them`;
    await reportStandingFinding(
      {
        key: `${REFUND_DISCOVERY_JOB}:discovery-unknown-payment`,
        ids: unknownPayment,
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: "refund-discovery.unknown-payment",
          level: "warning",
          tags: { provider: "razorpay" },
          extra: { gatewayRefundIds: unknownPayment },
        }),
    );
  }
  if (notHeld.length > 0) {
    const message = `Refund discovery: ${notHeld.length} gateway refund(s) the handler deferred are no longer retried: still deferred 7 days after the gateway created them, or met while ${MAX_REMEMBERED_DEFERRALS} deferred refunds were already remembered. Record each by hand once its payment is recorded`;
    await reportStandingFinding(
      {
        key: `${REFUND_DISCOVERY_JOB}:discovery-not-held`,
        ids: notHeld,
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: "refund-discovery.not-held",
          level: "error",
          tags: { provider: "razorpay" },
          extra: { gatewayRefundIds: notHeld },
        }),
    );
  }
  if (stoppedShort && next.cutRuns >= CUT_RUNS_BEFORE_FINDING) {
    await reportStandingFinding({
      key: `${REFUND_DISCOVERY_JOB}:discovery-cut`,
      ids: [stoppedShort.bound],
      message: `Refund discovery was cut by its ${stoppedShort.bound} bound on ${next.cutRuns} runs in a row; gateway refunds created after ${new Date((next.window?.to ?? 0) * 1000).toISOString()} are not read until the window ends`,
    });
  }
}
