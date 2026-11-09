import { humanizeEnum } from "@/lib/ui/tone";

describe("humanizeEnum", () => {
  it("turns an enum into words and keeps known acronyms in capitals", () => {
    expect(humanizeEnum("PENDING_VERIFICATION")).toBe("Pending Verification");
    expect(humanizeEnum("UPI")).toBe("UPI");
    expect(humanizeEnum("BANK_TRANSFER")).toBe("Bank Transfer");
    expect(humanizeEnum("GST_REGISTRATION_REQUIRED")).toBe(
      "GST Registration Required",
    );
    expect(humanizeEnum(null)).toBe("");
  });
});
