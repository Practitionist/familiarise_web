/**
 * @jest-environment node
 */

/**
 * An expired or terminated contract never renews (the auto-renew job reads
 * ACTIVE contracts only) and its terms are locked, so the Contracts page
 * shows auto-renew as not applicable and offers no Edit.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  contractAutoRenewLabel,
  contractIsEditable,
} from "@/lib/labels/org-labels";

describe("an ended contract", () => {
  it.each([
    ["EXPIRED", true, "Not applicable: the contract has expired"],
    ["TERMINATED", true, "Not applicable: the contract was terminated"],
    ["ACTIVE", true, "Yes"],
    ["ACTIVE", false, "No"],
    ["DRAFT", true, "Yes"],
  ] as const)("%s with autoRenew=%s reads %s", (status, autoRenew, label) => {
    expect(contractAutoRenewLabel({ status, autoRenew })).toBe(label);
  });

  it("offers Edit only while the contract can still change", () => {
    expect(contractIsEditable("DRAFT")).toBe(true);
    expect(contractIsEditable("ACTIVE")).toBe(true);
    expect(contractIsEditable("EXPIRED")).toBe(false);
    expect(contractIsEditable("TERMINATED")).toBe(false);
  });

  it("the page reads both helpers for the list, the detail and the row actions", () => {
    const page = readFileSync(
      path.join(
        process.cwd(),
        "app/dashboard/organization/[orgId]/contracts/page.tsx",
      ),
      "utf8",
    );
    expect(page).toMatch(/contractIsEditable\(c\.status\) && \(/);
    expect(page).toMatch(/contractAutoRenewLabel\(c\)/);
    expect(page).not.toMatch(/c\.autoRenew \? "Yes" : "No"/);
  });
});
