import type { StreamClientOptions } from "../../lib/stream/environment-guard";

/** An owner CLI may use the production Stream key from a laptop only when invoked with `--target=production`. */
export function scriptClientOptions(
  argv: readonly string[] = process.argv,
): StreamClientOptions {
  return {
    allowProductionKeyOutsideProduction: argv.includes("--target=production"),
  };
}
