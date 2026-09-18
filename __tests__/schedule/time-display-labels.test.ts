/**
 * #1703 F3 — every clock and date label on the grid comes from Intl in the
 * viewer's locale, and a zone is shown under one name however it was spelled.
 */
import { formatClockTime, formatDateTimeLabel } from "@/lib/time/display";
import {
  canonicalZone,
  zoneDisplayLabel,
  zoneLabel,
} from "@/lib/time/viewer-zone";

const at = new Date("2026-09-24T08:30:00Z");

describe("locale clock labels", () => {
  it("renders 12-hour for en-IN and 24-hour for en-GB with no toggle", () => {
    const opts = { zone: "Asia/Kolkata" };
    expect(formatClockTime(at, { ...opts, locale: "en-IN" })).toBe("2:00 pm");
    expect(formatClockTime(at, { ...opts, locale: "en-GB" })).toBe("14:00");
    // ICU decides the comma and "Sep" vs "Sept"; the shape is what is pinned.
    expect(formatDateTimeLabel(at, { ...opts, locale: "en-IN" })).toMatch(
      /^Thu,? 24 Sept?, 2:00 pm$/,
    );
  });
});

describe("zone names", () => {
  it("folds legacy aliases to the canonical IANA name", () => {
    expect(canonicalZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(canonicalZone(" US/Pacific ")).toBe("America/Los_Angeles");
    expect(canonicalZone("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("labels an aliased zone exactly like its canonical twin", () => {
    expect(zoneLabel(at, "Asia/Calcutta")).toBe(zoneLabel(at, "Asia/Kolkata"));
    expect(zoneDisplayLabel(at, "Asia/Calcutta")).toBe("IST (UTC+05:30)");
    expect(zoneDisplayLabel(at, "Etc/UTC")).toBe("UTC (UTC)");
  });
});
