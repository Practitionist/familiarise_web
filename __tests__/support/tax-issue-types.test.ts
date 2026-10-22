/**
 * @jest-environment node
 */

/**
 * The tax issue types route to the payments topic staff filter as billing,
 * are accepted at the boundary and carry their own labels.
 */

import { SupportIssueType } from "@prisma/client";
import { supportCaseTopicWhere, ticketTopic } from "@/lib/support/case-topic";
import { SupportIssueTypeEnum } from "@/schemas/enums";
import {
  ISSUE_TYPE_LABELS,
  PLATFORM_ISSUE_TYPE_CATEGORIES,
} from "@/utils/supportTicketUrl";

const TAX_TYPES = ["TAX_GST", "TDS_CERTIFICATE", "PAN_CARD_MISMATCH"] as const;

describe("tax issue types", () => {
  it.each(TAX_TYPES)("%s is a payments-topic ticket", (issueType) => {
    expect(ticketTopic({ category: issueType, issueType })).toBe("payments");
    expect(ticketTopic({ category: null, issueType })).toBe("payments");
  });

  it("matches the tax types in the payments topic filter", () => {
    const where = JSON.stringify(supportCaseTopicWhere("payments"));
    for (const t of TAX_TYPES) expect(where).toContain(`"${t}"`);
  });

  it("accepts every Prisma issue type at the Zod boundary", () => {
    for (const member of Object.values(SupportIssueType)) {
      expect(SupportIssueTypeEnum.safeParse(member).success).toBe(true);
    }
  });

  it("labels the tax types and groups them on the platform form", () => {
    expect(ISSUE_TYPE_LABELS.TAX_GST).toBe("GST invoice correction");
    expect(ISSUE_TYPE_LABELS.TDS_CERTIFICATE).toBe(
      "TDS certificate (Form 16A)",
    );
    expect(ISSUE_TYPE_LABELS.PAN_CARD_MISMATCH).toBe("PAN mismatch");
    expect(PLATFORM_ISSUE_TYPE_CATEGORIES.Tax).toEqual([...TAX_TYPES]);
  });
});
