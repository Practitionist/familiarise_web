/**
 * @jest-environment node
 */

/**
 * A GST or 26Q question had nowhere to go.
 *
 * The topic vocabulary had no tax member, so the three statutory issue types
 * fell through to "other" — the inbox filter could not separate a tax case
 * from a general one, and the category chip, the suggested articles and the
 * saved replies had nothing to say about it.
 */

import {
  CASE_TOPICS,
  CASE_TOPIC_LABEL,
  supportCaseTopicWhere,
  ticketTopic,
} from "@/lib/support/case-topic";
import { savedRepliesFor } from "@/lib/support/saved-replies";

describe("the tax topic", () => {
  it("files the three statutory issue types under tax", () => {
    expect(ticketTopic({ category: null, issueType: "TAX_GST" })).toBe("tax");
    expect(ticketTopic({ category: null, issueType: "TDS_CERTIFICATE" })).toBe(
      "tax",
    );
    expect(
      ticketTopic({ category: null, issueType: "PAN_CARD_MISMATCH" }),
    ).toBe("tax");
  });

  it("offers the topic in the inbox filter, with a label", () => {
    expect(CASE_TOPICS).toContain("tax");
    expect(CASE_TOPIC_LABEL.tax).toBe("Tax & statutory");
  });

  it("selects exactly the statutory issues under the topic", () => {
    expect(supportCaseTopicWhere("tax")).toMatchObject({
      OR: [
        { category: { in: [] } },
        {
          AND: [
            expect.any(Object),
            {
              OR: [
                {
                  issueType: {
                    in: ["TAX_GST", "TDS_CERTIFICATE", "PAN_CARD_MISMATCH"],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("offers the topic its own saved replies", () => {
    const general = savedRepliesFor("other");
    const own = savedRepliesFor("tax").length - general.length;
    expect(own).toBeGreaterThanOrEqual(5);
    expect(own).toBeLessThanOrEqual(8);
  });
});
