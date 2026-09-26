import { withOpsAction } from "@/lib/backoffice/ops-action-log";

/** #1771 K-6 — an ops note on a class: the OpsActionLog row is the note. */
export const POST = withOpsAction(
  "classSeries.support",
  "class.note",
  {},
  {
    mode: "tx",
    run: async (_tx, { params }) => ({
      target: { kind: "Class", id: params.classId },
      response: { noted: true },
    }),
  },
);
