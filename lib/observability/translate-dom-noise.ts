/**
 * Browser auto-translate rewrites text nodes, so React's later `removeChild` /
 * `insertBefore` throws a NotFoundError that is not an app defect.
 */

const DOM_MUTATION_MESSAGE =
  /Failed to execute '(removeChild|insertBefore)' on 'Node'/;

type EventWithException = {
  exception?: { values?: { type?: string; value?: string }[] };
};

export function isPageTranslated(
  doc: Pick<Document, "documentElement"> | undefined = typeof document ===
  "undefined"
    ? undefined
    : document,
): boolean {
  const root = doc?.documentElement;
  if (!root) return false;
  return /(^|\s)translated-(ltr|rtl)(\s|$)/.test(root.className);
}

export function isTranslateDomMutationNoise(
  event: EventWithException,
  translated: boolean = isPageTranslated(),
): boolean {
  if (!translated) return false;
  // Every linked exception must match, so a distinct app error chained to it still reports.
  const values = event.exception?.values ?? [];
  return (
    values.length > 0 &&
    values.every(
      (v) =>
        v.type === "NotFoundError" && DOM_MUTATION_MESSAGE.test(v.value ?? ""),
    )
  );
}
