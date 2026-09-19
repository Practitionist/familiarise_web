// #1124 — the full-graph arm: the modules /api/health and the public routes pull
// in (Prisma, Sentry, Better Auth), held but never executed. Same probe as bare.
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { requireApiAuth } from "@/lib/auth-helpers";
import { reportSentryError } from "@/lib/observability/report";
import prisma from "@/lib/prisma";

import { runProbe } from "../_probe";

export const dynamic = "force-dynamic";

const moduleLoadedAt = Date.now();

// Referenced so the bundler keeps the imports; none of them is called, because
// the question is module-init cost and not query or session cost (#1124).
const heldImports = {
  prisma: typeof prisma,
  sentry: typeof Sentry.captureException,
  report: typeof reportSentryError,
  auth: typeof requireApiAuth,
};

export async function GET() {
  const report = await runProbe(moduleLoadedAt);
  // Diagnostics must never be cached — see probe-bare.
  return NextResponse.json(
    { route: "probe-full", heldImports, ...report },
    { headers: { "Cache-Control": "no-store" } },
  );
}
