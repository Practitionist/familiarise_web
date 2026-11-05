/**
 * The `require` that reaches Node's resolver rather than the bundler's, so the
 * PDF JSX runtime and `@react-pdf/reconciler` load the same userland React.
 * Webpack exposes it as `__non_webpack_require__`; every other host (Turbopack,
 * Jest, a `tsx` script) gets Node's own `createRequire`, anchored at the app root
 * where `node_modules` lives.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

declare const __non_webpack_require__: ((id: string) => unknown) | undefined;

export const nodeRequire: (id: string) => unknown =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : createRequire(join(process.cwd(), "package.json"));
