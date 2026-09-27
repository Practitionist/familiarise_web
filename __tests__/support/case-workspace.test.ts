/**
 * #1527 — the case workspace's addressing and assist registry: every case
 * key round-trips through its URL segment, a case files under one topic
 * across both taxonomies, and each common topic carries 5–8 saved replies.
 */

import { caseKeyOf, parseCaseKey } from "@/lib/support/case-key";
import { threadTopic, ticketTopic } from "@/lib/support/case-topic";
import { savedRepliesFor } from "@/lib/support/saved-replies";

describe("case keys", () => {
  it.each([
    ["ticket", "0f8fad5b-6bd8-4e9d-9c9f-aa1166a3cb17"],
    ["thread", "demo0813-apt-ba"],
    ["booking", "abc123"],
  ] as const)("%s %s round-trips", (kind, id) => {
    expect(parseCaseKey(caseKeyOf({ kind, id }))).toEqual({ kind, id });
  });

  it("rejects anything that is not a case key", () => {
    for (const key of [
      "",
      "x_1",
      "t_",
      "t_a/b",
      "tickets",
      `t_${"a".repeat(65)}`,
    ]) {
      expect(parseCaseKey(key)).toBeNull();
    }
  });
});

describe("topics", () => {
  it("files an escalated ticket under its conversation's category", () => {
    expect(
      ticketTopic({ category: "RECORDING_ACCESS", issueType: "OTHER" }),
    ).toBe("recordings");
    expect(ticketTopic({ category: null, issueType: "CHARGED_TWICE" })).toBe(
      "payments",
    );
    expect(ticketTopic({ category: "free text", issueType: null })).toBe(
      "other",
    );
    expect(threadTopic("CANCEL_REFUND")).toBe("cancellation");
  });
});

describe("saved replies", () => {
  it("offers 5–8 of the topic's own replies before the general ones", () => {
    const general = savedRepliesFor("other");
    for (const topic of [
      "payments",
      "cancellation",
      "scheduling",
      "session",
      "technical",
      "recordings",
    ] as const) {
      const replies = savedRepliesFor(topic);
      const own = replies.length - general.length;
      expect(own).toBeGreaterThanOrEqual(5);
      expect(own).toBeLessThanOrEqual(8);
      expect(new Set(replies.map((r) => r.id)).size).toBe(replies.length);
    }
  });
});
