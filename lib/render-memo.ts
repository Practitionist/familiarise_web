import { cache } from "react";

/**
 * Memoizes `fn` per server render with React's `cache`. React 18 exports
 * `cache` only in the RSC build Next aliases in, so jobs and tests get the
 * plain function. Bound on first call so importing never touches `cache`.
 */
export function renderMemo<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  let bound: ((...args: Args) => Result) | undefined;
  return (...args) => {
    bound ??= typeof cache === "function" ? cache(fn) : fn;
    return bound(...args);
  };
}
