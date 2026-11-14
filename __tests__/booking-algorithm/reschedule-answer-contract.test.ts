/**
 * What each reschedule button SENDS is what its route accepts from that
 * viewer: the body parses the respond route's schema, the URL is a real route,
 * and only the proposer withdraws while only the other side answers.
 */

import fs from "fs";
import path from "path";
import {
  rescheduleAnswerRequest,
  rescheduleAnswersFor,
  type RescheduleSide,
} from "@/lib/appointments/reschedule-answer";
import { RescheduleRespondSchema } from "@/schemas/appointments";

const routeFile = (url: string) =>
  path.join(
    process.cwd(),
    "app",
    url.replace("/appt-1/", "/[appointmentId]/"),
    "route.ts",
  );

const proposal = (initiatorRole: RescheduleSide, times = 1) => ({
  initiatedById: initiatorRole === "CONSULTANT" ? "expert" : "learner",
  initiatorRole,
  proposedTimes: Array.from({ length: times }, () => ({})),
});

describe("reschedule answers: what each viewer may send", () => {
  it.each([
    ["learner", "CONSULTEE", "CONSULTANT", ["accept", "decline"]],
    ["expert", "CONSULTANT", "CONSULTANT", ["withdraw"]],
    ["expert", "CONSULTANT", "CONSULTEE", ["accept", "decline"]],
    ["learner", "CONSULTEE", "CONSULTEE", ["withdraw"]],
    ["operator", null, "CONSULTANT", []],
  ] as const)(
    "%s (%s) on a %s proposal may send %j",
    (viewerId, viewerSide, initiatorRole, expected) => {
      const answers = rescheduleAnswersFor({
        viewerId,
        viewerSide,
        proposal: proposal(initiatorRole),
      });
      expect(answers).toEqual(expected);
      const sent = answers.map((kind) => {
        const { url, body } = rescheduleAnswerRequest("appt-1", kind);
        return {
          route: fs.existsSync(routeFile(url)),
          body:
            kind === "withdraw"
              ? body === null
              : RescheduleRespondSchema.safeParse(body).success,
        };
      });
      expect(sent).toEqual(answers.map(() => ({ route: true, body: true })));
    },
  );

  it("a preference-only proposal can be declined, not accepted; a suspended member sends nothing", () => {
    const input = {
      viewerId: "learner",
      viewerSide: "CONSULTEE" as const,
      proposal: proposal("CONSULTANT", 0),
    };
    expect(rescheduleAnswersFor(input)).toEqual(["decline"]);
    expect(rescheduleAnswersFor({ ...input, readOnly: true })).toEqual([]);
  });

  it("the respond route parses its body with the same schema", () => {
    const src = fs.readFileSync(
      routeFile("/api/appointments/appt-1/reschedule/respond"),
      "utf8",
    );
    expect(src).toContain("RescheduleRespondSchema.safeParse(");
    expect(src).toContain("open.initiatedById !== session.user.id");
  });
});
