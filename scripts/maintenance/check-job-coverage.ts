/** Build-time job coverage check: prints each violation and exits 1. Reads files only. */
import fs from "node:fs";
import path from "node:path";
import { checkJobCoverage, registrySlugs } from "../../lib/cron/job-coverage";

const REGISTRY = path.resolve(__dirname, "../../lib/cron/cleanup-registry.ts");
const violations = checkJobCoverage({
  registrySlugs: registrySlugs(fs.readFileSync(REGISTRY, "utf8")),
});

if (violations.length > 0) {
  console.error(
    `check-job-coverage: ${violations.length} violation(s) between the job registry, the schedule and the freshness requirements:`,
  );
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log("check-job-coverage: ok");
