/**
 * @jest-environment node
 */

/**
 * The dispute topic.
 *
 * A buyer dispute files under the `DISPUTE` category, which is neither a
 * thread category nor an issue type — so the topic vocabulary maps it
 * explicitly. Without that, a claim would file under "other" and the
 * operator could not filter the queue for claims.
 */

import {
  CASE_CATEGORY_TOPIC,
  CASE_TOPIC_LABEL,
  CASE_TOPICS,
  supportCaseTopicWhere,
  ticketTopic,
} from "../../lib/support/case-topic";

describe("the dispute topic", () => {
  it("is part of the topic vocabulary, and labelled", () => {
    expect(CASE_TOPICS).toContain("dispute");
    expect(CASE_TOPIC_LABEL.dispute).toBe("Dispute");
  });

  it("files a case filed under DISPUTE under the dispute topic", () => {
    expect(ticketTopic({ category: "DISPUTE", issueType: null })).toBe(
      "dispute",
    );
    // A case category wins over the issue type, as a thread category does.
    expect(
      ticketTopic({ category: "DISPUTE", issueType: "TECHNICAL_ISSUES" }),
    ).toBe("dispute");
  });

  it("selects the dispute cases under the topic", () => {
    const where = supportCaseTopicWhere("dispute");
    expect(where.OR).toBeDefined();
    expect(JSON.stringify(where)).toContain("DISPUTE");
  });

  it("does not put a grievance under the tax topic", () => {
    // A statutory complaint is not a tax question.
    expect(CASE_CATEGORY_TOPIC.GRIEVANCE).toBeUndefined();
    expect(ticketTopic({ category: "GRIEVANCE", issueType: null })).toBe(
      "other",
    );
  });
});
