/**
 * Thin shim — the sentinel-origin implementation lives in `./safe-path.ts`
 * (Batch B6 merge). Kept so existing imports keep working; new code should
 * import from `@/lib/navigation/safe-path`.
 */
export { safeReturnTo } from "./safe-path";
