/**
 * @jest-environment node
 */

/**
 * A refusal toast's title names the problem. No toast in UI code is titled
 * "Error" or "Not done", and a coded refusal reads its title from the one
 * code-keyed table in `lib/errors/mapping/payment-error-toast-map.ts`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  codedRefusalToast,
  getErrorToast,
} from "@/lib/errors/mapping/payment-error-toast-map";
import { ErrorTypes } from "@/lib/errors/classification/payment-error-classification";
import { expertRescheduleCapMessage } from "@/lib/booking/reschedule-caps";

const ROOT = process.cwd();
// Built from parts so this file is not itself a match.
const BARE_TITLE = new RegExp(
  `title:\\s*"(${["Err", "or"].join("")}|${["Not ", "done"].join("")})"`,
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("refusal titles", () => {
  it("no toast under app/, components/, hooks/ or lib/ is titled Error or Not done", () => {
    const offenders = ["app", "components", "hooks", "lib"]
      .flatMap((dir) => sourceFiles(join(ROOT, dir)))
      .filter((file) => BARE_TITLE.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("the payment toast titles are sentence case with no trailing !", () => {
    expect(getErrorToast(ErrorTypes.NOT_PLACEABLE).title).toBe(
      "No free time in the first week",
    );
    expect(getErrorToast(ErrorTypes.SUBSCRIPTION_ALREADY_ACTIVE).title).toBe(
      "You already have this plan",
    );
    expect(getErrorToast(ErrorTypes.EVENT_FULL).title).toBe(
      "This session is full",
    );
    expect(
      getErrorToast(ErrorTypes.DUPLICATE_REGISTRATION).description,
    ).not.toMatch(/!/);
  });

  it("a coded refusal takes its title from the table and keeps the server's sentence", () => {
    expect(
      codedRefusalToast(
        "EXPERT_RESCHEDULE_CAP",
        "You've already rescheduled this booking 2 times.",
        "Couldn't request a reschedule",
      ),
    ).toEqual({
      title: "No reschedules left on this booking",
      description: "You've already rescheduled this booking 2 times.",
    });
  });

  it("an unlisted code keeps the caller's title", () => {
    expect(
      codedRefusalToast(
        "SOMETHING_ELSE",
        "The server's sentence.",
        "Couldn't request a reschedule",
      ),
    ).toEqual({
      title: "Couldn't request a reschedule",
      description: "The server's sentence.",
    });
  });

  it("EXPERT_RESCHEDULE_CAP says the recommended cancel is recorded on the reliability record", () => {
    expect(expertRescheduleCapMessage("booking")).toBe(
      "You've already rescheduled this booking 2 times. If the time no longer works, cancel it: the client gets a full refund. Cancelling a confirmed booking, free or paid, is recorded on your reliability record. Only you and our team see it.",
    );
    expect(expertRescheduleCapMessage("trial")).toMatch(
      /^You've already moved this trial once\. .*the learner gets a full refund\. .*reliability record/,
    );
  });
});
