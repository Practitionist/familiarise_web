import { z } from "zod";

import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import {
  afterSeatRemovalLift,
  liftSeatRemovalTx,
} from "@/lib/booking/seat-removal-lift";
import {
  SeatLiftBodySchema,
  SeatLiftResponseSchema,
} from "@/schemas/seat-removal-lift";

const Params = z.object({ appointmentId: z.string().uuid() });

/**
 * Staff lift an organiser or conduct removal so the attendee may register
 * again. It clears the block only: no seat is given back and no support
 * decision is written, so an upheld finding stays on the record.
 */
export const POST = withOpsAction(
  "appointments.liftSeatRemoval",
  "appointment.seat.liftRemoval",
  SeatLiftBodySchema.shape,
  {
    mode: "tx",
    run: async (tx, { body, actor, params }) => {
      const { appointmentId } = Params.parse(params);
      const lifted = await liftSeatRemovalTx(tx, {
        appointmentId,
        userId: body.userId,
        actorUserId: actor.userId,
        door: "staff",
      }).catch((error: unknown) => {
        if (error instanceof BookingRuleError) {
          throw new OpsRefusal(error.code, error.message, error.httpStatus);
        }
        throw error;
      });
      return {
        target: { kind: "AppointmentParticipant", id: lifted.participantId },
        // The lift clears the mark, so the audit row keeps who removed the seat and how.
        before: {
          removedByUserId: lifted.removedByUserId,
          removal: lifted.kind,
        },
        after: {
          userId: body.userId,
          conduct: lifted.conduct,
          rejoinPath: lifted.rejoinPath,
        },
        response: SeatLiftResponseSchema.parse({
          lifted: true,
          rejoinPath: lifted.rejoinPath,
          conduct: lifted.conduct,
        }),
        afterCommit: () =>
          afterSeatRemovalLift(appointmentId, body.userId, lifted),
      };
    },
  },
  { stepUp: true, serializable: true },
);
