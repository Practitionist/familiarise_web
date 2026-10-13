/** Deterministic human-readable moderation report reference token. */
export function formatReportReference(reportId: string): string {
  return `RPT-${reportId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}
