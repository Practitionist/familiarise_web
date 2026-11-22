"use client";

import { OccurrenceOutcome } from "@prisma/client";
import { z } from "zod";

import { SESSION_OUTCOME_LABEL } from "@/lib/labels/session-labels";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

/** The route's answer; anything else words as a plain "done". */
const rereadAnswerSchema = z.object({
  result: z.enum([
    "settled",
    "too-early",
    "not-final",
    "expired",
    "unavailable",
  ]),
  verdict: z
    .object({
      outcome: z.nativeEnum(OccurrenceOutcome),
      deliveredMinutes: z.number().nullable(),
    })
    .nullable(),
});

const NOT_STORED: Record<
  Exclude<z.infer<typeof rereadAnswerSchema>["result"], "settled">,
  string
> = {
  "too-early": "Stream's record is not final yet; try again later.",
  "not-final":
    "Stream still shows the call as live or incomplete; try again later.",
  expired: "Stream no longer holds this call's record.",
  unavailable: "Stream did not answer; try again in a few minutes.",
};

/** How the toast words the re-read's answer. */
export function rereadToast(data: Record<string, unknown>): string {
  const parsed = rereadAnswerSchema.safeParse(data);
  if (!parsed.success) return "Read from Stream again";
  const { result, verdict } = parsed.data;
  if (result !== "settled") return NOT_STORED[result];
  if (!verdict) return "Stream's record is stored.";
  const label = SESSION_OUTCOME_LABEL[verdict.outcome];
  const minutes =
    verdict.deliveredMinutes === null
      ? ""
      : `, ${verdict.deliveredMinutes} minutes delivered`;
  return `Stream's record is stored. It reads as ${label}${minutes}; set the outcome to apply it.`;
}

/** The `session.reread-attendance` door: stores Stream's record and says what it shows. */
export function RereadAttendanceDialog({
  occurrenceId,
  invalidate,
  onClose,
}: Readonly<{
  occurrenceId: string;
  invalidate: readonly (readonly unknown[])[];
  onClose: () => void;
}>) {
  const door = useOpsDoor({
    success: rereadToast,
    invalidate,
    onDone: onClose,
  });
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Read this session from Stream again"
      description="Stores Stream's record of who was in the call. It does not change the outcome or move money."
      confirmLabel="Read from Stream"
      pending={door.isPending}
      onConfirm={(reason) =>
        door.mutate({
          url: `/api/admin/sessions/${occurrenceId}/attendance`,
          body: { reason },
        })
      }
    />
  );
}
