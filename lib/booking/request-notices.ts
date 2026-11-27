/**
 * The expert's notices for a new booking request: read and rendered before
 * the request's transaction, staged inside it keyed by the request, and
 * flushed by the caller after the commit.
 */
import type { Tx } from "@/lib/prisma";
import { prepareNewBookingRequestEmail } from "@/lib/email/senders/booking";
import {
  screenPreparedEmails,
  stageScreenedEmails,
  type ScreenedRecipientEmails,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import {
  prepareNewBookingRequestBell,
  stagePreparedBells,
  type PreparedBell,
  type StagedTrigger,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";

export interface PreparedRequestNotices {
  bells: PreparedBell[];
  emails: ScreenedRecipientEmails;
}

export interface StagedRequestNotices {
  bells: StagedTrigger[];
  emails: StagedRecipientEmail[];
}

/** Reads and renders the notices before the transaction; writes nothing. */
export async function prepareNewRequestNotices(args: {
  consultantUserId: string;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  organizationId: string | null;
  startsAt: Date;
  respondBy: Date;
  reviewUrl: string;
}): Promise<PreparedRequestNotices> {
  const bells = await prepareNewBookingRequestBell(args.consultantUserId, {
    ...notificationScope(args.organizationId),
    consulteeName: args.consulteeName,
    planTitle: args.planTitle,
    appointmentType: "CONSULTATION",
    requestedDateTime: args.startsAt.toISOString(),
    dashboardUrl: args.reviewUrl,
  });
  const prepared = await prepareNewBookingRequestEmail({
    // The dedupe key is set when the rows are staged, once the request exists.
    requestId: "pending",
    consultantUserId: args.consultantUserId,
    consultantName: args.consultantName,
    consulteeName: args.consulteeName,
    planTitle: args.planTitle,
    appointmentType: "CONSULTATION",
    requestedAt: args.startsAt,
    respondBy: args.respondBy,
    reviewUrl: args.reviewUrl,
  });
  return { bells, emails: await screenPreparedEmails(prepared) };
}

/** Stages the prepared notices on the request's transaction: one insert per table. */
export async function stageNewRequestNotices(
  tx: Pick<Tx, "notificationOutbox" | "failedEmail">,
  consultationId: string,
  prepared: PreparedRequestNotices,
): Promise<StagedRequestNotices> {
  // Keyed to the request: a retry that reaches the insert again stages nothing new.
  const bells = await stagePreparedBells(
    tx,
    prepared.bells.map((bell) => ({
      ...bell,
      dedupeKey: `booking-request:${consultationId}`,
    })),
  );
  const emails = await stageScreenedEmails(
    tx,
    prepared.emails,
    `request:${consultationId}`,
  );
  return { bells, emails };
}
