/** Locale-free string order by UTF-16 code unit, for keys and signatures. */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
