/**
 * GET /api/auth/sso/domain-check?email=<email>
 *
 * Pre-auth home-realm discovery for the sign-in and sign-up pages. Returns
 * `ssoBody` whenever an approved provider covers the email's verified domain,
 * with `enforceSSO` saying whether password and Google sign-in are off for it.
 * Unauthenticated, so it returns only the org name and the provider slug.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { lookupDomainSso } from "@/lib/sso/enforce-session";

const QuerySchema = z.object({
  email: z.string().email(),
});

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({
    email: url.searchParams.get("email"),
  });
  if (!parsed.success) {
    return NextResponse.json({ enforceSSO: false });
  }

  const domain = parsed.data.email.split("@")[1]?.toLowerCase();
  if (!domain) return NextResponse.json({ enforceSSO: false });

  // Shared with session.create.before, so the button and the gate agree.
  const sso = await lookupDomainSso(prisma, domain);
  const providerId = sso?.providerIds[0];
  if (!sso || !providerId) {
    return NextResponse.json({ enforceSSO: false });
  }

  const org = await prisma.organization.findUnique({
    where: { id: sso.organizationId },
    select: { name: true },
  });

  // An org SSO login lands in that org's dashboard; the JIT membership is
  // committed during the callback, so the org layout resolves.
  const orgHome = `/dashboard/organization/${sso.organizationId}/home`;
  return NextResponse.json({
    enforceSSO: sso.enforced,
    organizationName: org?.name ?? null,
    ssoBody: {
      providerId,
      domain,
      callbackURL: `${APP_URL}/auth/signin?ssoCallback=1&callbackUrl=${encodeURIComponent(orgHome)}`,
      // Every refusal in the callback redirects here with `?error=<code>`.
      errorCallbackURL: `${APP_URL}/auth/signin`,
    },
  });
}
