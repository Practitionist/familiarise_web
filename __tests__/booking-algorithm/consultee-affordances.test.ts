import {
  consulteeDestructiveAction,
  consulteeMayReschedule,
} from "@/lib/appointments/consultee-affordances";

describe("#1005 consultee affordances", () => {
  it("allows reschedule only for 1:1 kinds", () => {
    expect(consulteeMayReschedule("CONSULTATION")).toBe(true);
    expect(consulteeMayReschedule("SUBSCRIPTION")).toBe(true);
    expect(consulteeMayReschedule("WEBINAR")).toBe(false);
    expect(consulteeMayReschedule("CLASS")).toBe(false);
    expect(consulteeMayReschedule("TRIAL")).toBe(false);
  });

  it("maps destructive actions by kind", () => {
    expect(consulteeDestructiveAction("CONSULTATION")).toBe("cancel-booking");
    expect(consulteeDestructiveAction("SUBSCRIPTION")).toBe("cancel-booking");
    expect(consulteeDestructiveAction("TRIAL")).toBe("cancel-trial");
    expect(consulteeDestructiveAction("WEBINAR")).toBe("leave-event");
    expect(consulteeDestructiveAction("CLASS")).toBe("leave-event");
  });
});
