/** A list's count line: printed only once the read answered, never a zero it did not read. */
export function countLabel(
  state: { loading: boolean; failed: boolean },
  total: number,
  words: (total: number) => string,
  failedText: string,
): string {
  if (state.loading) return "Loading…";
  if (state.failed) return failedText;
  return words(total);
}
