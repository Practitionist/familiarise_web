/**
 * A refused allocation names times, never parties, for every viewer; the
 * user copy carries no validator tags, ISO strings or internal counts — that
 * detail rides `details` to logs only.
 */

import {
  refusalCopyFor,
  slotTakenRefusal,
  validationRefusal,
} from "@/lib/booking/allocation/refusal-copy";

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

describe("refusal copy", () => {
  const findings = [
    "[CONFLICT] Slot already booked: 2030-01-07T10:00:00.000Z",
    "[TOO_SOON] 1 time(s) start within 120 min: 2030-01-01T11:00:00.000Z",
    "[OUTSIDE_AVAILABILITY] Slot 2030-01-07T10:00:00.000Z is outside",
    "[COLLABORATOR_CONFLICT] Co-host Priya Sharma: [CONFLICT] Slot already booked",
    "[DAILY_LIMIT] 2030-01-07 has 3 sessions",
    "[VALIDATION] Slots must be consecutive. Gap detected between 1/7/2030",
    "something untagged with 2030-01-07T10:00:00.000Z",
  ];

  it.each(findings)("never leaks a tag, an ISO time or a name: %s", (f) => {
    const copy = refusalCopyFor([f]);
    expect(copy).not.toMatch(/\[[A-Z_]+\]/);
    expect(copy).not.toMatch(ISO);
    expect(copy).not.toMatch(/Priya|Sharma/);
    expect(copy.length).toBeGreaterThan(10);
  });

  it("names a taken time as booked, with no party", () => {
    expect(refusalCopyFor([findings[0]])).toBe(
      "One of these times is already booked. Pick another time.",
    );
  });

  it("keeps the raw findings for logs in details only", () => {
    const refusal = validationRefusal(findings.slice(0, 2));
    expect(refusal.errorCode).toBe("VALIDATION_ERROR");
    expect(refusal.details).toEqual({ findings: findings.slice(0, 2) });
    expect(refusal.message).not.toMatch(ISO);

    const taken = slotTakenRefusal([findings[0]]);
    expect(taken.errorCode).toBe("SLOT_TAKEN");
    expect(taken.httpStatus).toBe(409);
    expect(taken.message).not.toMatch(ISO);
  });
});
