/**
 * GST state-code normalisation — shared by the IRP payload builder and the
 * GST place-of-supply derivation.
 *
 * Two representations reach us for the same state and they never compare
 * equal: the seller side is env-sourced alpha (`SUPPLIER_STATE_CODE`, e.g.
 * "KA") while the buyer side is written numeric, because the settings form
 * strips non-digits from `OrganizationTaxInfo.gstStateCode` (e.g. "29").
 * Normalise both through `numericStateCode` before any comparison — see #1132.
 */

// 2-digit numeric GST state codes keyed by the alpha codes this codebase
// stores in gstStateCode / SUPPLIER_STATE_CODE. The GSTIN prefix is
// authoritative; this only covers the env-sourced seller fallback.
export const STATE_ALPHA_TO_NUMERIC: Record<string, string> = {
  JK: "01", HP: "02", PB: "03", CH: "04", UT: "05", HR: "06", DL: "07",
  RJ: "08", UP: "09", BR: "10", SK: "11", AR: "12", NL: "13", MN: "14",
  MZ: "15", TR: "16", ML: "17", AS: "18", WB: "19", JH: "20", OD: "21",
  CG: "22", MP: "23", GJ: "24", DD: "26", MH: "27", KA: "29", GA: "30",
  LD: "31", KL: "32", TN: "33", PY: "34", AN: "35", TG: "36", AP: "37",
  LA: "38",
};

/**
 * Resolve a state to its 2-digit numeric GST code. GSTIN[0:2] wins when
 * present; otherwise map the stored alpha code; pass through anything already
 * numeric. Returns null when the state cannot be determined — callers must
 * treat null as "unknown" and fall back to IGST, never as a match.
 */
export function numericStateCode(
  gstin: string | null | undefined,
  alphaOrNumeric: string | null | undefined,
): string | null {
  if (gstin && /^[0-9]{2}/.test(gstin)) return gstin.slice(0, 2);
  if (!alphaOrNumeric) return null;
  const v = alphaOrNumeric.trim().toUpperCase();
  if (/^[0-9]{2}$/.test(v)) return v;
  return STATE_ALPHA_TO_NUMERIC[v] ?? null;
}
