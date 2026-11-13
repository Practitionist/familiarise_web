/**
 * The request maps have no SCHEDULED state, and a plan never awaits payment:
 * a 1:1 or a plan is APPROVED from capture or placement until it completes.
 */
import {
  REQUEST_ALLOWED_FROM,
  SUBSCRIPTION_ALLOWED_FROM,
} from "../../lib/booking/transitions";

describe("request status maps", () => {
  it("know no SCHEDULED state", () => {
    for (const map of [REQUEST_ALLOWED_FROM, SUBSCRIPTION_ALLOWED_FROM]) {
      expect(Object.keys(map)).not.toContain("SCHEDULED");
      for (const from of Object.values(map))
        expect(from).not.toContain("SCHEDULED");
    }
  });

  it("complete a booking from APPROVED only", () => {
    expect(REQUEST_ALLOWED_FROM.COMPLETED).toEqual(["APPROVED"]);
    expect(SUBSCRIPTION_ALLOWED_FROM.COMPLETED).toEqual(["APPROVED"]);
  });

  it("cancel a plan from every live state", () => {
    expect(SUBSCRIPTION_ALLOWED_FROM.CANCELLED).toEqual([
      "PENDING",
      "APPROVED",
    ]);
  });

  it("never let a plan await payment: it is paid at checkout", () => {
    expect(SUBSCRIPTION_ALLOWED_FROM.APPROVED_PENDING_PAYMENT).toEqual([]);
    for (const from of Object.values(SUBSCRIPTION_ALLOWED_FROM))
      expect(from).not.toContain("APPROVED_PENDING_PAYMENT");
  });
});
