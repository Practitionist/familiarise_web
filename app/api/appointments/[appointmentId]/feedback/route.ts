/**
 * #appt-support — private per-participant CSAT (1–5 + note), distinct from the
 * public ConsultantReview. Re-submitting edits.
 *
 * #1554 — a rating is about ONE CALL (`occurrenceId` names it) or about the
 * WHOLE BOOKING (no `occurrenceId`; the row's occurrence is NULL). A subscription
 * holds up to 24 calls, so one rating per appointment alone meant a single score
 * for a three-month package; both levels now coexist, one row per person per
 * level, guarded by the `appointment_feedback_level_key` sidecar unique.
 * GET returns every row of this booking the caller has written.
 */

import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { appointmentRaterRole } from "@/lib/data/appointment-detail";
import { heldOccurrence } from "@/lib/reviews";
import { AppointmentIdParams } from "@/schemas/support";
import { parseRouteParams, supportError } from "@/lib/api/support-http";
import { apiError } from "@/lib/errors/api-error";
import { Refusal } from "@/lib/errors/refusal";
import {
  authorizeAppointment,
  appointmentAuthzError,
} from "@/lib/api/appointment-access";

const FEEDBACK_ROUTE = "appointments.feedback";

/** How much of the booking the GET answers for. Parsed rather than compared: an
 *  unrecognised value used to fall through to the single-appointment answer, so a
 *  typo'd or renamed scope returned a NARROWER result than the caller asked for and
 *  said 200 about it. */
const scopeSchema = z.enum(["appointment", "booking"]).default("appointment");

const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
  /** Which call of this booking is being rated; absent = the whole booking. */
  occurrenceId: z.string().min(1).max(64).optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: FEEDBACK_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    const auth = await authorizeAppointment(appointmentId);
    if ("code" in auth) {
      return appointmentAuthzError(auth, {
        route: FEEDBACK_ROUTE,
        appointmentId,
      });
    }
    // #705 — the CONSULTANT sees the individual ratings their calls received.
    // A deliberate product call: at this volume an aggregate over two ratings
    // tells nobody anything, so the detail is what makes it actionable. The
    // copy the rater sees says so plainly — nothing here is promised private.
    // On a 1:1 booking this identifies the rater, which is exactly why
    // SessionRatingRow states it on the control itself rather than leaving it
    // quietly enabled.
    const asProvider =
      appointmentRaterRole(auth.userId, auth.detail) === "PROVIDER";

    // #1540 — one request for the whole BOOKING. #1554 made a booking ONE
    // Appointment, so `scope=booking` and the default now read the same row;
    // the parameter stays accepted so existing callers do not 400.
    const scope = scopeSchema.safeParse(
      new URL(req.url).searchParams.get("scope") ?? undefined,
    );
    if (!scope.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: scope.error.flatten(),
        context: { route: FEEDBACK_ROUTE, action: "get", appointmentId },
      });
    }
    const scopeIds = [auth.detail.appointment.id];

    // Which calls of this booking the caller may rate at all, so the timeline
    // offers stars only where a rating would be accepted rather than erroring
    // after the click.
    const rateable = asProvider
      ? []
      : await prisma.appointmentOccurrence.findMany({
          where: {
            appointmentId: { in: scopeIds },
            ...heldOccurrence(auth.userId),
          },
          select: { id: true },
        });

    // Every call of this booking the caller has rated (or, for the provider,
    // every attendee rating on it), so the timeline can show a per-session
    // breakdown instead of one number for the package.
    const feedback = await prisma.appointmentFeedback.findMany({
      where: asProvider
        ? { appointmentId: { in: scopeIds }, raterRole: "CONSULTEE" }
        : { appointmentId: { in: scopeIds }, userId: auth.userId },
      select: {
        id: true,
        appointmentOccurrenceId: true,
        rating: true,
        // The SCORE is disclosed to the provider; the free-text note is not.
        // Every comment in this table was typed into AppointmentCsatCard, whose
        // own header called it "private per-participant CSAT" — and the row that
        // replaced it takes stars only, so it cannot re-ask for consent that was
        // never given. Nothing renders this field for a provider today, so
        // withholding it costs no feature.
        comment: !asProvider,
        createdAt: true,
      },
      // A provider could otherwise infer a rater from ordering on a group call.
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json(
      {
        data: feedback,
        rateableSlotIds: rateable.map((s) => s.id),
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: FEEDBACK_ROUTE, action: "get", appointmentId },
    });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const id = await parseRouteParams(AppointmentIdParams, params, {
    route: FEEDBACK_ROUTE,
  });
  if (!id.ok) return id.response;
  const { appointmentId } = id.data;
  try {
    const auth = await authorizeAppointment(appointmentId);
    if ("code" in auth) {
      return appointmentAuthzError(auth, {
        route: FEEDBACK_ROUTE,
        appointmentId,
      });
    }
    // CSAT is a PARTICIPANT's private rating: staff/admin read access must
    // not become write access — a privileged non-participant's row would
    // pollute the org quality aggregate with a rating they never earned.
    // #705 — and WHICH side they are on. A consultant rating their own session
    // used to be indistinguishable from an attendee's rating and landed in the
    // org quality average; the aggregate now filters on CONSULTEE, so an
    // unattributable row fails closed instead of counting.
    const raterRole = appointmentRaterRole(auth.userId, auth.detail);
    if (!raterRole) {
      return supportError({
        status: 403,
        code: "FORBIDDEN",
        context: { route: FEEDBACK_ROUTE, appointmentId },
      });
    }

    const body = feedbackSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return supportError({
        status: 400,
        code: "VALIDATION_FAILED",
        detail: body.error.flatten(),
        context: { route: FEEDBACK_ROUTE, appointmentId },
      });
    }

    // The occurrence must belong to THIS appointment: without the check a
    // caller could rate a call from a booking they merely have access to the
    // id of. Without one the rating is about the whole booking, which still
    // needs at least one held call to rate at all.
    const slot = await prisma.appointmentOccurrence.findFirst({
      where: {
        ...(body.data.occurrenceId ? { id: body.data.occurrenceId } : {}),
        appointmentId,
        // You may rate a call you ATTENDED, or one nobody could have recorded
        // (an offline session). A COMPLETED slot the caller never joined does
        // not qualify: a no-show rating would otherwise feed the consultant's
        // quality signal. `heldOccurrence` also excludes cancelled and rescheduled
        // calls, which never happened at all.
        ...heldOccurrence(auth.userId),
      },
      select: { id: true, consultantProfileId: true },
    });
    if (!slot) {
      // A stale rating row, not a fault: answered as a refusal so it never
      // becomes a Sentry warning (FAMILIARISE_WEB-35).
      return apiError({
        tag: "[Feedback.POST]",
        error: new Refusal({
          code: "OCCURRENCE_NOT_FOUND",
          httpStatus: 404,
          userMessage:
            "That meeting isn't part of this booking, or it didn't take place",
          context: {
            route: FEEDBACK_ROUTE,
            appointmentId,
            occurrenceId: body.data.occurrenceId ?? null,
          },
        }),
      });
    }

    // #1554 — the rating belongs to the MEETING, and the occurrence IS the
    // meeting: one row per held call; NULL is the whole-booking level.
    const ratedOccurrenceId = body.data.occurrenceId ? slot.id : null;

    // #1580 — the one live PRESENTER on the rated call's plan, if the booking
    // is a group event: one read through the wrapper's event.
    const presenter = await prisma.collaborator.findFirst({
      where: {
        tier: "PRESENTER",
        status: "ACCEPTED",
        OR: [
          {
            webinarPlan: {
              webinars: { some: { appointment: { id: appointmentId } } },
            },
          },
          {
            classPlan: {
              classes: { some: { appointment: { id: appointmentId } } },
            },
          },
        ],
      },
      select: { consultantProfileId: true },
    });

    // `updatedAt` is stamped HERE, not by `@updatedAt`. Prisma populates that
    // attribute on create as well as on update, so the column could never be NULL
    // — and NULL is the meaning the schema documents: never edited since it was
    // written. Only a changed OPINION counts, the same rule the review upsert
    // applies to `editedAt`: re-submitting identical stars is idempotent and must
    // not read to a moderator as somebody who keeps changing their mind.
    //
    // findFirst + update/create rather than an upsert: the per-level unique is
    // a NULLS NOT DISTINCT sidecar Prisma cannot name as a compound key, so a
    // racing second create surfaces as P2002 and answers 409.
    const previous = await prisma.appointmentFeedback.findFirst({
      where: {
        appointmentId,
        appointmentOccurrenceId: ratedOccurrenceId,
        userId: auth.userId,
      },
      select: { id: true, rating: true, comment: true },
    });
    const opinionChanged =
      previous !== null &&
      (previous.rating !== body.data.rating ||
        // An absent `comment` is "not supplied", which the update already treats
        // as leaving the stored note alone — so it is not an edit either.
        (body.data.comment !== undefined &&
          (previous.comment ?? "") !== body.data.comment));

    let feedback;
    try {
      feedback = previous
        ? await prisma.appointmentFeedback.update({
            where: { id: previous.id },
            data: {
              rating: body.data.rating,
              comment: body.data.comment,
              raterRole,
              ...(opinionChanged ? { updatedAt: new Date() } : {}),
            },
          })
        : await prisma.appointmentFeedback.create({
            data: {
              appointmentOccurrenceId: ratedOccurrenceId,
              appointmentId,
              userId: auth.userId,
              organizationId: auth.organizationId,
              // #1550 — the consultant on the rated call (or on the booking's
              // held call, for a whole-booking rating).
              consultantProfileId: slot.consultantProfileId,
              // #1580 — the co-presenter the rating also speaks to.
              coPresenterProfileId: presenter?.consultantProfileId ?? null,
              rating: body.data.rating,
              comment: body.data.comment,
              raterRole,
            },
          });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return supportError({
          status: 409,
          code: "CONFLICT",
          message: "You have already rated this; reload and edit it instead",
          context: { route: FEEDBACK_ROUTE, action: "save", appointmentId },
        });
      }
      throw error;
    }
    return NextResponse.json({ data: feedback });
  } catch (cause) {
    return supportError({
      status: 500,
      code: "INTERNAL",
      cause,
      context: { route: FEEDBACK_ROUTE, action: "save", appointmentId },
    });
  }
}
