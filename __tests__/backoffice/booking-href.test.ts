import {
  bookingHref,
  operatorOpsHref,
} from "../../lib/backoffice/booking-href";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";

describe("bookingHref", () => {
  it("opens the console's Appointments page on the booking", () => {
    expect(bookingHref("/dashboard/staff", "a b")).toBe(
      "/dashboard/staff/appointments?open=a%20b",
    );
  });
});

describe("operatorOpsHref", () => {
  it("sends an ADMIN who is not a party to the admin console's Ops panel", () => {
    expect(operatorOpsHref({ role: "ADMIN" }, false, APPT)).toBe(
      `/dashboard/admin/appointments?open=${APPT}`,
    );
  });

  it("sends STAFF who is not a party to the staff console", () => {
    expect(operatorOpsHref({ role: "STAFF" }, false, APPT)).toBe(
      `/dashboard/staff/appointments?open=${APPT}`,
    );
  });

  it("leaves a party alone, including an ADMIN who is the consultant", () => {
    expect(operatorOpsHref({ role: "ADMIN" }, true, APPT)).toBeNull();
    expect(operatorOpsHref({ role: "STAFF" }, true, APPT)).toBeNull();
  });

  it("leaves anyone who is not an operator alone", () => {
    expect(operatorOpsHref({ role: "USER" }, false, APPT)).toBeNull();
    expect(operatorOpsHref(null, false, APPT)).toBeNull();
    expect(operatorOpsHref(undefined, false, APPT)).toBeNull();
  });
});
