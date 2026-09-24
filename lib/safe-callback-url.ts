// Thin shim — the sentinel-origin implementation lives in
// `./navigation/safe-path.ts` (Batch B6 merge). Kept so existing imports
// keep working; new code should import from `@/lib/navigation/safe-path`.
export { safeSameOriginPath } from "./navigation/safe-path";
