/**
 * CGST Act s.34(2), as amended by the Finance Act 2022: a credit note can
 * reduce output tax only if declared by 30 November following the end of the
 * financial year of the supply (or the annual return, if earlier; not tracked
 * here). After that, a refund gets a commercial credit note: base only, no tax.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The last instant (end of 30 November, IST) a tax credit note can be issued for a supply. */
export function gstCreditNoteCutoff(supplyDate: Date): Date {
  const ist = new Date(supplyDate.getTime() + IST_OFFSET_MS);
  const fyEndYear =
    ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() + 1 : ist.getUTCFullYear();
  return new Date(Date.UTC(fyEndYear, 10, 30, 23, 59, 59, 999) - IST_OFFSET_MS);
}

export function isPastGstCreditNoteCutoff(
  supplyDate: Date,
  now: Date = new Date(),
): boolean {
  return now.getTime() > gstCreditNoteCutoff(supplyDate).getTime();
}

/** Prefixed to a commercial credit note's reason so the register reader can tell it apart. */
export const COMMERCIAL_CREDIT_NOTE_REASON_PREFIX =
  "Commercial credit note (past the CGST s.34(2) time limit): ";
