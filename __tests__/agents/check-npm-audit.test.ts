import { blockingFindings } from "../../scripts/ci/check-npm-audit";

const advisory = (id: string, severity: string) => ({
  title: `advisory ${id}`,
  url: `https://github.com/advisories/${id}`,
  severity,
});

const report = {
  vulnerabilities: {
    zod: { name: "zod", via: [advisory("GHSA-zod", "high")] },
    "better-call": { name: "better-call", via: ["zod"] },
    seroval: { name: "seroval", via: [advisory("GHSA-moderate", "moderate")] },
    axios: { name: "axios", via: [advisory("GHSA-crit", "critical")] },
  },
};

const allow = [{ id: "GHSA-zod", until: "2026-12-08", reason: "no fix" }];

describe("check-npm-audit", () => {
  it("blocks high and critical advisories, skipping moderate and transitive names", () => {
    const { blocking } = blockingFindings(report, "2026-11-08", []);
    expect(blocking.map((f) => f.id).sort()).toEqual(["GHSA-crit", "GHSA-zod"]);
  });

  it("lets an allowlisted advisory through until its expiry date", () => {
    expect(
      blockingFindings(report, "2026-12-08", allow).blocking.map((f) => f.id),
    ).toEqual(["GHSA-crit"]);
  });

  it("blocks an allowlisted advisory once its entry has expired", () => {
    const { blocking, expired } = blockingFindings(report, "2026-12-09", allow);
    expect(blocking.map((f) => f.id).sort()).toEqual(["GHSA-crit", "GHSA-zod"]);
    expect(expired).toEqual(allow);
  });
});
