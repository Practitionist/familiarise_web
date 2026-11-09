/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";

const mockAudit = {
  signatoryName: "",
  signatoryDesignation: "",
  signedOn: "",
  periodFrom: "",
  periodTo: "",
  nextDueOn: "",
  outcomeSummary: "",
};

jest.mock("@/lib/company", () => ({
  ...jest.requireActual("@/lib/company"),
  get DARK_PATTERN_AUDIT() {
    return mockAudit;
  },
}));
jest.mock("@/lib/reviews", () => ({ MIN_RATED_CLIENTS_ONE_TO_ONE: 5 }));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { isDarkPatternAuditSigned } from "@/lib/company";
import ComplianceCertificatePage from "@/app/(pages)/compliance-certificate/page";
import HowWeRankPage from "@/app/(pages)/how-we-rank/page";

beforeEach(() => {
  Object.assign(mockAudit, {
    signatoryName: "",
    signatoryDesignation: "",
    signedOn: "",
    periodFrom: "",
    periodTo: "",
    nextDueOn: "",
    outcomeSummary: "",
  });
});

describe("the certificate gate", () => {
  it("needs both a signatory and a signing date", () => {
    const signed = { ...mockAudit, signatoryName: "A", signedOn: "2026-12-20" };
    expect(isDarkPatternAuditSigned(signed)).toBe(true);
    expect(isDarkPatternAuditSigned({ ...signed, signedOn: "" })).toBe(false);
    expect(isDarkPatternAuditSigned({ ...signed, signatoryName: " " })).toBe(
      false,
    );
  });

  it("is not found while the audit is unsigned", () => {
    expect(() => ComplianceCertificatePage()).toThrow("NEXT_NOT_FOUND");
  });

  it("names the signatory, dates and the ranking and grievance links once signed", () => {
    Object.assign(mockAudit, {
      signatoryName: "Asha Rao",
      signatoryDesignation: "Director",
      signedOn: "2026-12-20",
      periodFrom: "2026-11-01",
      periodTo: "2026-12-15",
      nextDueOn: "2027-12-20",
      outcomeSummary: "Eleven findings fixed; two open.",
    });
    render(<ComplianceCertificatePage />);
    expect(screen.getByText(/Asha Rao, Director/)).toBeTruthy();
    expect(screen.getAllByText(/20 December 2026/).length).toBeGreaterThan(0);
    expect(screen.getByText(/20 December 2027/)).toBeTruthy();
    expect(screen.getByText("Eleven findings fixed; two open.")).toBeTruthy();
    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(
      expect.arrayContaining(["/how-we-rank", "/grievance"]),
    );
  });
});

describe("how we rank", () => {
  it("states every sort and that placement is never paid for", () => {
    render(<HowWeRankPage />);
    for (const label of [
      "Highest rated:",
      "Recently reviewed:",
      "Most reviews:",
      "Most booked:",
      "Newest:",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(
      screen.getByText(/We do not accept payment for placement/),
    ).toBeTruthy();
    expect(screen.getByText("Sponsored")).toBeTruthy();
  });
});
