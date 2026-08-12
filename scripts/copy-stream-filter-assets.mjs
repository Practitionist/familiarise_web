#!/usr/bin/env node
/**
 * Self-hosts the Stream call-filter assets (#1134).
 *
 * Both add-ons default to fetching their model and WASM from `unpkg.com` at
 * runtime, from inside a live consultation. That is a third party on the call
 * path, an entry we would have to open in the CSP `connect-src`, and an
 * availability dependency nobody is monitoring. Copying the same files out of
 * node_modules into `public/` removes all three, and guarantees the assets
 * match the installed SDK version because they come from it.
 *
 * Runs from `postinstall`, so a fresh clone and every Netlify build produce
 * them. The copies are gitignored — they are build output, not source, and
 * together they are ~32MB.
 *
 * A missing package is a warning, not a failure: the features degrade to
 * "unavailable" on their own, and breaking `npm install` over an optional
 * call effect would be worse than shipping without it.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Walks up for `node_modules/<pkg>`. Agent worktrees live inside the repo and
 * share the root's node_modules, so resolving relative to this file alone
 * would miss it.
 */
function findPackageDir(packageName) {
  let dir = projectRoot;
  for (;;) {
    const candidate = join(dir, "node_modules", packageName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const ASSETS = [
  {
    package: "@stream-io/video-filters-web",
    // `BackgroundFiltersProvider basePath="/mediapipe"` appends /models and /wasm.
    from: "mediapipe",
    to: "public/mediapipe",
    label: "background blur (MediaPipe)",
  },
  {
    package: "@stream-io/audio-filters-web",
    // `new NoiseCancellation({ basePath: "/nc-models" })` appends the .kef name.
    from: "src/krispai/models",
    to: "public/nc-models",
    label: "noise cancellation (Krisp)",
  },
];

let copied = 0;

for (const asset of ASSETS) {
  const packageDir = findPackageDir(asset.package);
  if (!packageDir) {
    console.warn(
      `[stream-filters] ${asset.package} is not installed — skipping ${asset.label}.`,
    );
    continue;
  }

  const source = join(packageDir, asset.from);
  if (!existsSync(source)) {
    console.warn(
      `[stream-filters] ${asset.package} has no ${asset.from} — skipping ${asset.label}.`,
    );
    continue;
  }

  const destination = join(projectRoot, asset.to);
  // Replaced rather than merged: a stale file from a previous SDK version and a
  // current one sitting in the same directory is the hardest version of this
  // bug to see.
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  copied += 1;
}

if (copied > 0) {
  console.log(`[stream-filters] copied ${copied} asset set(s) into public/.`);
}
