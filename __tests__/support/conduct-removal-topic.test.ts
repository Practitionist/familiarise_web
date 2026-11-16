/** @jest-environment node */
/** A conduct removal case has its own topic, label and filter, never "Other". */
import {
  CASE_TOPIC_LABEL,
  caseBookingLink,
  supportCaseTopicWhere,
  ticketTopic,
} from "@/lib/support/case-topic";

it("labels a conduct removal case and filters it apart from Other", () => {
  const topic = ticketTopic({ category: "CONDUCT_REMOVAL", issueType: null });
  expect(topic).toBe("removal");
  expect(CASE_TOPIC_LABEL[topic]).toBe("Conduct removal");
  expect(JSON.stringify(supportCaseTopicWhere("removal"))).toContain(
    "CONDUCT_REMOVAL",
  );
  expect(JSON.stringify(supportCaseTopicWhere("other"))).toContain(
    "CONDUCT_REMOVAL",
  );
});

it("sends a removed learner to their Cancelled list, never to a booking page they can no longer open", () => {
  const base = "/dashboard/consultee/ce-1/appointments";
  expect(caseBookingLink("removal", base, "appt-1")).toEqual({
    href: `${base}?tab=cancelled`,
    readsBooking: false,
  });
  expect(caseBookingLink("session", base, "appt-1")).toEqual({
    href: `${base}/appt-1`,
    readsBooking: true,
  });
});
