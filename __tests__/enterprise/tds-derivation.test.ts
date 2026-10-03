/**
 * @jest-environment node
 */

/**
 * Live TDS derivation — covers the precedence rules the audit team will
 * inspect first when a quarterly Form 26Q / 27Q reconciliation kicks
 * back. Each case mirrors a row the cron at
 * `jobs/compliance/derive-tds-msme.ts` will encounter in production.
 */

import {
  computeTdsForPayout,
  isValidPan,
  NO_PAN_BPS_194O,
  NO_PAN_RATE_194O,
  PAN_FALLBACK_BPS,
  resolveEffectiveTdsRate,
  TDS_SECTION_DEFAULT_BPS,
  TDS_SECTION_DEFAULTS,
  type TdsConsultantInput,
} from "@/lib/compliance/tds";

/** Minimal helper — pads only the fields the derivation reads. */
function profile(overrides: Partial<TdsConsultantInput> = {}): TdsConsultantInput {
  return {
    panNumber: "ABCDE1234F",
    residencyStatus: "RESIDENT",
    tdsSection: null,
    tdsRateBps: null,
    tdsLowerRateCert: null,
    providerCountry: "IN",
    ...overrides,
  };
}

describe("computeTdsForPayout — section precedence", () => {
  it("resident with valid PAN defaults to 194-O at 0.1%", () => {
    const result = computeTdsForPayout({
      grossAmountPaise: 100_000, // ₹1,000
      consultant: profile(),
    });
    expect(result.tdsSection).toBe("194O");
    expect(result.tdsRate).toBe(TDS_SECTION_DEFAULTS["194O"]);
    expect(result.tdsRate).toBeCloseTo(0.001);
    expect(result.tdsAmountPaise).toBe(100);
    expect(result.fallbackApplied).toBe(false);
    expect(result.dtaaRateApplied).toBeNull();
    expect(result.reason).toMatch(/194O/);
  });

  it("honours an explicit 194J section override at 10%", () => {
    const result = computeTdsForPayout({
      grossAmountPaise: 100_000,
      consultant: profile({ tdsSection: "194J" }),
    });
    expect(result.tdsSection).toBe("194J");
    expect(result.tdsRate).toBeCloseTo(0.1);
    expect(result.tdsAmountPaise).toBe(10_000);
    expect(result.reason).toMatch(/194J/);
    expect(result.reason).toMatch(/override/i);
  });
});

describe("computeTdsForPayout — PAN fallback (Section 194-O no-PAN carve-out)", () => {
  it("withholds 5% (194-O no-PAN carve-out) when PAN is null", () => {
    const result = computeTdsForPayout({
      grossAmountPaise: 100_000,
      consultant: profile({ panNumber: null }),
    });
    expect(result.tdsRate).toBe(NO_PAN_RATE_194O);
    expect(result.tdsAmountPaise).toBe(5_000);
    expect(result.fallbackApplied).toBe(true);
    expect(result.reason).toMatch(/194-O no-PAN fallback/i);
  });

  it("withholds 5% (194-O no-PAN carve-out) when PAN is malformed", () => {
    const result = computeTdsForPayout({
      grossAmountPaise: 100_000,
      consultant: profile({ panNumber: "NOT-A-PAN" }),
    });
    expect(result.tdsRate).toBe(NO_PAN_RATE_194O);
    expect(result.tdsAmountPaise).toBe(5_000);
    expect(result.fallbackApplied).toBe(true);
    expect(result.reason).toMatch(/194-O no-PAN fallback/i);
  });
});

describe("computeTdsForPayout — DTAA (NON_RESIDENT)", () => {
  it("US non-resident under 194-O default keeps the 0.1% section rate (DTAA 10% is higher)", () => {
    // Spec: DTAA only overrides if strictly LOWER than the section
    // default. US treaty rate is 10%, default 194-O is 0.1% → section
    // wins.
    const result = computeTdsForPayout({
      grossAmountPaise: 100_000,
      consultant: profile({
        residencyStatus: "NON_RESIDENT",
        providerCountry: "US",
      }),
    });
    expect(result.tdsSection).toBe("194O");
    expect(result.tdsRate).toBeCloseTo(0.001);
    expect(result.tdsAmountPaise).toBe(100);
    expect(result.dtaaRateApplied).toBeNull();
    expect(result.reason).toMatch(/not lower/i);
  });

  it("US non-resident with 194J override keeps section default (DTAA 10% == section 10%, not lower)", () => {
    const result = computeTdsForPayout({
      grossAmountPaise: 100_000,
      consultant: profile({
        residencyStatus: "NON_RESIDENT",
        providerCountry: "US",
        tdsSection: "194J",
      }),
    });
    expect(result.tdsSection).toBe("194J");
    expect(result.tdsRate).toBeCloseTo(0.1);
    expect(result.tdsAmountPaise).toBe(10_000);
    expect(result.dtaaRateApplied).toBeNull();
  });

  it("non-resident from a country outside the DTAA table falls back to section default", () => {
    const result = computeTdsForPayout({
      grossAmountPaise: 100_000,
      consultant: profile({
        residencyStatus: "NON_RESIDENT",
        providerCountry: "ZZ", // not in dtaa-rates.json
      }),
    });
    expect(result.tdsSection).toBe("194O");
    expect(result.tdsRate).toBeCloseTo(0.001);
    expect(result.dtaaRateApplied).toBeNull();
    expect(result.reason).toMatch(/no dtaa entry/i);
  });
});

describe("computeTdsForPayout — Section 197 lower-rate certificate", () => {
  it("uses cert rate (5%) when both cert ref and tdsRateBps are set", () => {
    const result = computeTdsForPayout({
      grossAmountPaise: 100_000,
      consultant: profile({
        tdsLowerRateCert: "CERT-2025-00042",
        tdsRateBps: 500, // #781 §C — 5% as integer bps
      }),
    });
    expect(result.tdsRate).toBeCloseTo(0.05);
    expect(result.tdsAmountPaise).toBe(5_000);
    expect(result.fallbackApplied).toBe(false);
    expect(result.reason).toMatch(/197/);
  });
});

describe("isValidPan", () => {
  it("accepts a well-formed PAN", () => {
    expect(isValidPan("ABCDE1234F")).toBe(true);
  });
  it("rejects null / empty / mis-shapen values", () => {
    expect(isValidPan(null)).toBe(false);
    expect(isValidPan(undefined)).toBe(false);
    expect(isValidPan("")).toBe(false);
    expect(isValidPan("abcde1234f")).toBe(false); // lowercase
    expect(isValidPan("ABCDE12345")).toBe(false); // wrong shape
  });
});

describe("Integer basis-point math & resolveEffectiveTdsRate (#1368, #1367)", () => {
  it("exposes integer basis-point constants and populates rateAppliedBps on computeTdsForPayout", () => {
    expect(TDS_SECTION_DEFAULT_BPS["194O"]).toBe(10);
    expect(TDS_SECTION_DEFAULT_BPS["194J"]).toBe(1000);
    expect(NO_PAN_BPS_194O).toBe(500);
    expect(PAN_FALLBACK_BPS).toBe(2000);

    const res = computeTdsForPayout({
      grossAmountPaise: 505_000, // 505_000 * 10 / 10_000 = 505p
      consultant: profile(),
    });
    expect(res.rateAppliedBps).toBe(10);
    expect(res.rateApplied).toBe(0.001);
    expect(res.tdsAmountPaise).toBe(505);
  });

  it("resolves effective TDS rate from DB TDSRate row and falls back to static defaults", async () => {
    const findFirst = jest.fn().mockResolvedValueOnce({
      lawCode: "IT2025",
      rateBps: 20,
      noPanRateBps: 500,
      thresholdPaise: BigInt(6_000_000),
      paymentCode: "1005",
    });
    const fromDb = await resolveEffectiveTdsRate(
      { tdsRate: { findFirst } },
      "194O",
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(fromDb).toMatchObject({
      section: "194O",
      lawCode: "IT2025",
      rateBps: 20,
      thresholdPaise: BigInt(6_000_000),
      paymentCode: "1005",
      source: "db",
    });
    expect(findFirst).toHaveBeenCalledTimes(1);

    findFirst.mockResolvedValueOnce(null);
    const fallback = await resolveEffectiveTdsRate(
      { tdsRate: { findFirst } },
      "194O",
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(fallback).toMatchObject({
      section: "194O",
      rateBps: 10,
      thresholdPaise: BigInt(50_000_000),
      source: "default",
    });

    const fallback194J = await resolveEffectiveTdsRate(
      null,
      "194J",
      new Date("2025-12-01T00:00:00Z"),
    );
    expect(fallback194J).toMatchObject({
      section: "194J",
      lawCode: "IT1961",
      rateBps: 1000,
      noPanRateBps: 2000,
      thresholdPaise: BigInt(3_000_000),
      source: "default",
    });

    const fallback194C = await resolveEffectiveTdsRate(
      null,
      "194C",
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(fallback194C).toMatchObject({
      section: "194C",
      lawCode: "IT2025",
      rateBps: 200,
      thresholdPaise: null,
      source: "default",
    });
  });

  it("rethrows serialization/aborted-tx errors (P2034 / 25P02) and live-client DB failures while falling back on non-client mock errors", async () => {
    const p2034Err = Object.assign(new Error("Serialization failure"), {
      code: "P2034",
    });
    await expect(
      resolveEffectiveTdsRate(
        { tdsRate: { findFirst: jest.fn().mockRejectedValueOnce(p2034Err) } },
        "194O",
      ),
    ).rejects.toThrow("Serialization failure");

    const abortedTxErr = new Error(
      "current transaction is aborted, commands ignored until end of transaction block (25P02)",
    );
    await expect(
      resolveEffectiveTdsRate(
        {
          tdsRate: { findFirst: jest.fn().mockRejectedValueOnce(abortedTxErr) },
        },
        "194O",
      ),
    ).rejects.toThrow("25P02");

    const liveClientErr = new Error("connection reset");
    await expect(
      resolveEffectiveTdsRate(
        {
          $executeRawUnsafe: jest.fn(),
          tdsRate: {
            findFirst: jest.fn().mockRejectedValueOnce(liveClientErr),
          },
        } as unknown as Parameters<typeof resolveEffectiveTdsRate>[0],
        "194O",
      ),
    ).rejects.toThrow("connection reset");

    const mockFallback = await resolveEffectiveTdsRate(
      {
        tdsRate: {
          findFirst: jest.fn().mockRejectedValueOnce(new Error("stub error")),
        },
      },
      "194O",
      new Date("2026-06-01T00:00:00Z"),
    );
    expect(mockFallback.source).toBe("default");
    expect(mockFallback.rateBps).toBe(10);
  });
});

