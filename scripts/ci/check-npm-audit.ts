/**
 * CI guard: fail when a production dependency carries a high or critical npm
 * advisory, except an advisory allowlisted below until its expiry date. An
 * expired entry fails like any other advisory, so an exception cannot outlive
 * its review.
 *
 * Usage: { npm audit --omit=dev --json || true; } | tsx scripts/ci/check-npm-audit.ts
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

type Allowance = { id: string; until: string; reason: string };

export const ALLOWLIST: readonly Allowance[] = [
  {
    id: "GHSA-mrhx-c7xc-m3w5",
    until: "2026-12-08",
    reason:
      "zod 3 has no patched release; the zod 4 migration removes it. Request bodies are capped by the host.",
  },
  {
    id: "GHSA-fc5q-39xc-vjpf",
    until: "2026-12-17",
    reason:
      "picomatch has no patched release; it reaches production only through @sentry/nextjs's build-time rollup plugin, which matches repo-authored globs, never request input.",
  },
];

const BLOCKING = new Set(["high", "critical"]);

const Advisory = z.object({
  title: z.string(),
  url: z.string(),
  severity: z.string(),
  range: z.string().optional(),
});
const AuditReport = z.object({
  vulnerabilities: z.record(
    z.object({
      name: z.string(),
      via: z.array(z.union([z.string(), Advisory])),
    }),
  ),
});
type AuditReport = z.infer<typeof AuditReport>;

export type Finding = {
  pkg: string;
  id: string;
  title: string;
  severity: string;
};

const idOf = (url: string) => url.split("/").pop() ?? url;

/** Direct high/critical advisories not covered by a live allowlist entry. */
export function blockingFindings(
  report: AuditReport,
  today: string,
  allowlist: readonly Allowance[] = ALLOWLIST,
): { blocking: Finding[]; expired: Allowance[] } {
  const live = new Set(
    allowlist.filter((a) => a.until >= today).map((a) => a.id),
  );
  const blocking: Finding[] = [];
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via) {
      if (typeof via === "string" || !BLOCKING.has(via.severity)) continue;
      const id = idOf(via.url);
      if (live.has(id)) continue;
      blocking.push({
        pkg: vuln.name,
        id,
        title: via.title,
        severity: via.severity,
      });
    }
  }
  const expired = allowlist.filter((a) => a.until < today);
  return { blocking, expired };
}

function main() {
  // The audit report arrives on stdin (fd 0).
  const report = AuditReport.parse(JSON.parse(readFileSync(0, "utf8")));
  const today = new Date().toISOString().slice(0, 10);
  const { blocking, expired } = blockingFindings(report, today);
  for (const a of expired) {
    console.error(`Allowlist entry ${a.id} expired on ${a.until}: ${a.reason}`);
  }
  if (blocking.length === 0) {
    console.log("check-npm-audit: no blocking production advisory.");
    return;
  }
  console.error("High or critical advisories in production dependencies:\n");
  for (const f of blocking) {
    console.error(`  ${f.pkg}: ${f.severity} ${f.id} ${f.title}`);
  }
  process.exit(1);
}

if (process.argv[1]?.endsWith("check-npm-audit.ts")) main();
