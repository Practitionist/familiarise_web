/**
 * Dispute discovery: pages the gateway's dispute list and hands each dispute
 * the database does not hold, or holds in another status, to the dispute
 * webhook's own handlers. It crosses the vendor boundary: only the gateway
 * knows of a dispute whose webhook never arrived.
 */

import type { DisputeStatus } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import type { ConfigSkip } from "@/lib/cron/config-skip";
import { getRazorpayClient } from "@/lib/payments/core/razorpay";
import { listRazorpayDisputes } from "@/lib/payments/core/razorpay-disputes";
import {
  isTerminalDisputeChange,
  mapDisputeStatus,
} from "@/lib/payments/dispute-status";
import {
  errorMessageOf,
  reportSentryMessage,
} from "@/lib/observability/report";
import { reportStandingFinding } from "@/lib/observability/standing-finding";
import type { RazorpayListedDispute } from "@/schemas/webhooks/razorpay";
import {
  CUT_RUNS_BEFORE_FINDING,
  readDiscoveryState,
  type DiscoveryStoppedShort,
} from "./checkpoint";

/** The lock name of the job that runs this pass; its run rows keep the position. */
const DISPUTE_DISCOVERY_JOB = "reconcile-disputes";

/** The gateway's largest page. */
const PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 3;

/**
 * The list takes no time filter and a dispute carries no update time, so the
 * pass walks the whole list: `skip` is where the next run starts, and it
 * returns to 0 at the last page. `cutRuns` counts runs in a row a bound ended.
 */
const stateSchema = z.object({
  skip: z.number().int().nonnegative(),
  cutRuns: z.number().int().nonnegative(),
});
type DiscoveryState = z.infer<typeof stateSchema>;

export interface DisputeDiscoveryRun {
  /** Set when the pass did not run. */
  skipped?: ConfigSkip;
  /** Disputes the gateway returned in this run. */
  listed: number;
  /** Disputes with no row before this run that the handlers created. */
  imported: number;
  /** Disputes whose row already holds the listed status. */
  alreadyKnown: number;
  /** Disputes whose row moved to the listed status. */
  updated: number;
  /** Disputes whose row differs from the listing and that the handler left as they were. */
  notAdopted: number;
  /** Disputes the handler deferred: no captured payment is held for them. */
  unknownPayment: number;
  errors: string[];
  stoppedShort: DiscoveryStoppedShort | null;
  /** The position the next run resumes from; absent when the pass did not run. */
  checkpoint?: string;
}

/** One id per listed dispute, status and phase, so a handler records what it did not adopt once. */
function discoveryEventId(listed: RazorpayListedDispute): string {
  return `dispute-discovery:${listed.id}:${listed.status.toLowerCase()}:${listed.phase ?? "none"}`;
}

/**
 * Replays the two webhooks in order: the dispute is created open, which places
 * its holds, and then moved to the listed status, which settles a verdict.
 */
async function importDispute(
  listed: RazorpayListedDispute,
): Promise<"imported" | "unknown-payment"> {
  const { handleDisputeCreated, handleDisputeUpdated, DeferSignal } =
    await import("@/app/api/webhooks/utils");
  const eventId = discoveryEventId(listed);
  const created = await handleDisputeCreated(
    listed.id,
    listed.payment_id,
    listed.amount,
    listed.currency || "INR",
    listed.reason_description || listed.reason_code || "unknown",
    "open",
    listed.respond_by ?? null,
    listed.deduct_at_onset === false,
    // The redrive flag keeps an unknown payment to this pass's one report a run.
    { isRedrive: true, phase: listed.phase ?? null, webhookEventId: eventId },
  );
  if (created instanceof DeferSignal) return "unknown-payment";
  if (mapDisputeStatus(listed.status) !== "NEEDS_RESPONSE") {
    await handleDisputeUpdated(
      listed.id,
      listed.status,
      null,
      listed.respond_by ?? null,
      listed.amount_deducted ?? null,
      listed.phase ?? null,
      eventId,
    );
  }
  return "imported";
}

/** Hands a held dispute's listed status to the webhook's update path; true when the row took it. */
async function updateDispute(
  listed: RazorpayListedDispute,
  stored: DisputeStatus,
  mapped: DisputeStatus | null,
): Promise<boolean> {
  const { handleDisputeUpdated } = await import("@/app/api/webhooks/utils");
  await handleDisputeUpdated(
    listed.id,
    listed.status,
    null,
    listed.respond_by ?? null,
    listed.amount_deducted ?? null,
    listed.phase ?? null,
    discoveryEventId(listed),
  );
  if (mapped === null || mapped === stored) return false;
  const after = await prisma.dispute.findUnique({
    where: { disputeId: listed.id },
    select: { status: true },
  });
  return after?.status === mapped;
}

/**
 * One bounded pass. The position moves past a page only when every dispute on
 * it was handled.
 */
export async function discoverGatewayDisputes(
  outOfTime: () => boolean,
): Promise<DisputeDiscoveryRun> {
  const run: DisputeDiscoveryRun = {
    listed: 0,
    imported: 0,
    alreadyKnown: 0,
    updated: 0,
    notAdopted: 0,
    unknownPayment: 0,
    errors: [],
    stoppedShort: null,
  };
  if (!getRazorpayClient()) {
    return {
      ...run,
      skipped: "RAZORPAY_KEY_ID or RAZORPAY_SECRET not configured",
    };
  }

  const state: DiscoveryState = (await readDiscoveryState(
    DISPUTE_DISCOVERY_JOB,
    stateSchema,
  )) ?? { skip: 0, cutRuns: 0 };

  const unknownPayment: string[] = [];
  let skip = state.skip;
  let pagesHandled = 0;
  let listDone = false;

  while (!listDone) {
    if (outOfTime()) {
      run.stoppedShort = { bound: "deadline", pagesHandled };
      break;
    }
    if (pagesHandled >= MAX_PAGES_PER_RUN) {
      run.stoppedShort = { bound: "pages", pagesHandled };
      break;
    }
    let page: RazorpayListedDispute[];
    try {
      page = await listRazorpayDisputes(PAGE_SIZE, skip);
    } catch (error) {
      run.errors.push(`Dispute list: ${errorMessageOf(error)}`);
      break;
    }
    run.listed += page.length;

    const stored = new Map(
      (
        await prisma.dispute.findMany({
          where: { disputeId: { in: page.map((dispute) => dispute.id) } },
          select: { disputeId: true, status: true },
        })
      ).map((row) => [row.disputeId, row.status]),
    );
    let pageFailed = false;
    let cutInPage = false;
    for (const listed of page) {
      const status = stored.get(listed.id);
      const mapped = mapDisputeStatus(listed.status);
      if (
        status !== undefined &&
        status === mapped &&
        !isTerminalDisputeChange(status, mapped, listed.phase)
      ) {
        run.alreadyKnown++;
        continue;
      }
      if (outOfTime()) {
        cutInPage = true;
        break;
      }
      try {
        if (status === undefined) {
          const outcome = await importDispute(listed);
          if (outcome === "imported") run.imported++;
          else unknownPayment.push(listed.id);
        } else if (await updateDispute(listed, status, mapped)) {
          run.updated++;
        } else {
          run.notAdopted++;
        }
      } catch (error) {
        pageFailed = true;
        run.errors.push(`Dispute ${listed.id}: ${errorMessageOf(error)}`);
      }
    }
    if (cutInPage) {
      run.stoppedShort = { bound: "deadline", pagesHandled };
      break;
    }
    if (pageFailed) break;
    pagesHandled++;
    skip += page.length;
    listDone = page.length < PAGE_SIZE;
  }

  run.unknownPayment = unknownPayment.length;
  const next: DiscoveryState = listDone
    ? { skip: 0, cutRuns: 0 }
    : {
        skip,
        cutRuns: run.stoppedShort ? state.cutRuns + 1 : state.cutRuns,
      };
  run.checkpoint = JSON.stringify(next);

  await reportDiscoveryFindings(unknownPayment, run.stoppedShort, next);
  return run;
}

/** Once per run: the disputes no payment was found for, and a pass a bound keeps cutting. */
async function reportDiscoveryFindings(
  unknownPayment: string[],
  stoppedShort: DiscoveryStoppedShort | null,
  next: DiscoveryState,
): Promise<void> {
  if (unknownPayment.length > 0) {
    const message = `Dispute discovery: ${unknownPayment.length} gateway dispute(s) are on a payment the database does not hold as captured; nothing was written for them`;
    await reportStandingFinding(
      {
        key: `${DISPUTE_DISCOVERY_JOB}:discovery-unknown-payment`,
        ids: unknownPayment,
        message,
      },
      () =>
        reportSentryMessage(message, {
          subsystem: "payments",
          op: "dispute-discovery.unknown-payment",
          level: "error",
          tags: { provider: "razorpay" },
          extra: { gatewayDisputeIds: unknownPayment },
        }),
    );
  }
  if (stoppedShort && next.cutRuns >= CUT_RUNS_BEFORE_FINDING) {
    await reportStandingFinding({
      key: `${DISPUTE_DISCOVERY_JOB}:discovery-cut`,
      ids: [stoppedShort.bound],
      message: `Dispute discovery was cut by its ${stoppedShort.bound} bound on ${next.cutRuns} runs in a row; the dispute list is read ${MAX_PAGES_PER_RUN * PAGE_SIZE} at a time and the next run resumes at ${next.skip}`,
    });
  }
}
