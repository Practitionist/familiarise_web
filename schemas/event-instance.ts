import { z } from "zod";

// `status` is accepted only so the route can refuse it with USE_CANCEL_ROUTE;
// every other unknown key (plan or appointment re-pointing) is stripped.
const statusProbe = z.unknown().optional();
const feedbackSummary = z.string().max(5000).nullable().optional();
const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

// The plan editor's only status intents: save a draft or publish it. Every
// other status belongs to the cancel route or server lifecycle code.
export const EventEditorStatusSchema = z.enum(["DRAFT", "SCHEDULED"]);

export const WebinarInstanceUpdateSchema = z.object({
  status: statusProbe,
  feedbackSummary,
});

export const ClassInstanceUpdateSchema = z
  .object({
    status: statusProbe,
    feedbackSummary,
    schedulingPeriodStartsAt: isoDate.optional(),
    schedulingPeriodEndsAt: isoDate.optional(),
  })
  .superRefine((val, ctx) => {
    const start = val.schedulingPeriodStartsAt;
    const end = val.schedulingPeriodEndsAt;
    if ((start === undefined) !== (end === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedulingPeriodEndsAt"],
        message: "Send both scheduling period bounds together.",
      });
    } else if (start && end && start.getTime() >= end.getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schedulingPeriodEndsAt"],
        message: "The scheduling period must end after it starts.",
      });
    }
  });
