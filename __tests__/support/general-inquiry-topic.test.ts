/** @jest-environment node */
/** A "General inquiry" case reads as its own topic, never "Other". */
import { CASE_TOPIC_LABEL, ticketTopic } from "@/lib/support/case-topic";

it("labels a GENERAL_INQUIRY case General inquiry", () => {
  const topic = ticketTopic({
    category: "GENERAL_INQUIRY",
    issueType: "GENERAL_INQUIRY",
  });
  expect(topic).toBe("general");
  expect(CASE_TOPIC_LABEL[topic]).toBe("General inquiry");
});
