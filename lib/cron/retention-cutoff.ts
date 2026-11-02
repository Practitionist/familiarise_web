/** Calendar years in UTC, so a statutory minimum never loses its leap days. */
export function yearsBefore(now: number, years: number): Date {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff;
}
