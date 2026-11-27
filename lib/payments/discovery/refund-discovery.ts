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
 * runs. `cutRuns` counts runs in a row that a bound ended.
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
  /** Refunds the handler deferred: no payment, top-up or invoice holds their payment, or its capture is not recorded. */
  unknownPayment: number;
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

/** Hands one listed refund to the webhook's handler with what its event would have carried. */
async function handOver(listed: RazorpayListedRefund): Promise<HandOver> {
  const local = await prisma.payment.findFirst({
    where: { gatewayPaymentId: listed.payment_id },
    select: { paymentIntent: true },
  });
  let orderId = local?.paymentIntent ?? listed.payment_id;
  let captured: boolean | undefined;
  const client = local ? null : getRazorpayClient();
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
 * One bounded pass. The position moves past a page only when every refund on
 * it was handled, and past a window only at its last page.
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
  )) ?? { since: null, window: null, cutRuns: 0 };
  const window = state.window ?? {
    from:
      state.since === null
        ? nowSeconds - FIRST_LOOKBACK_SECONDS
        : state.since - OVERLAP_SECONDS,
    to: nowSeconds,
    skip: 0,
  };

  const unknownPayment: string[] = [];
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
    let pageFailed = false;
    let cutInPage = false;
    for (const listed of page) {
      if (known.has(listed.id)) {
        run.alreadyKnown++;
        continue;
      }
      if (mapGatewayRefundStatus(listed.status) === RefundStatus.FAILED) {
        run.gatewayFailed++;
        continue;
      }
      if (outOfTime()) {
        cutInPage = true;
        break;
      }
      try {
        const outcome = await handOver(listed);
        if (outcome === "imported") run.imported++;
        else if (outcome === "no-refund-row") run.noRefundRow++;
        else unknownPayment.push(listed.id);
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

  run.unknownPayment = unknownPayment.length;
  const next: DiscoveryState = windowDone
    ? { since: window.to, window: null, cutRuns: 0 }
    : {
        since: state.since,
        window: { ...window, skip },
        cutRuns: run.stoppedShort ? state.cutRuns + 1 : state.cutRuns,
      };
  run.checkpoint = JSON.stringify(next);

  await reportDiscoveryFindings(unknownPayment, run.stoppedShort, next);
  return run;
}

/** Once per run: the refunds no payment was found for, and a pass a bound keeps cutting. */
async function reportDiscoveryFindings(
  unknownPayment: string[],
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
  if (stoppedShort && next.cutRuns >= CUT_RUNS_BEFORE_FINDING) {
    await reportStandingFinding({
      key: `${REFUND_DISCOVERY_JOB}:discovery-cut`,
      ids: [stoppedShort.bound],
      message: `Refund discovery was cut by its ${stoppedShort.bound} bound on ${next.cutRuns} runs in a row; gateway refunds created after ${new Date((next.window?.to ?? 0) * 1000).toISOString()} are not read until the window ends`,
    });
  }
}
