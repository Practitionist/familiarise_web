/**
 * GET   /api/org-workspace/[orgWorkspaceId]/settings
 * PATCH /api/org-workspace/[orgWorkspaceId]/settings
 *
 * Operator-level preferences for the cross-org workspace dashboard.
 * Settings live on `OrgWorkspaceProfile`:
 *
 *   - `defaultLandingOrganizationId` — the org to open when the operator
 *     hits the workspace shell without a specific orgId. Validated on
 *     PATCH against the caller's ACTIVE OWNER memberships so we can't
 *     pin an org the operator doesn't actually own.
 *   - `notificationRoutingMode` — BELL_AND_EMAIL | BELL_ONLY | EMAIL_ONLY
 *     | NEITHER. Read by Novu dispatchers when an org-lifecycle event
 *     fires for an operator who owns multiple orgs.
 *   - `locale` — BCP 47 string used for cross-org workspace formatting.
 *     Per-org pages still use the org's own region defaults.
 *   - `currencyDisplayCode` — ISO 4217 used for the workspace overview
 *     rollup numbers (per-org pages render in the org's billing
 *     currency).
 *
 * Auth: the URL's `orgWorkspaceId` must match the caller's
 * `orgWorkspaceProfileId`. Mirrors the IDOR posture in
 * `app/api/org-workspace/[orgWorkspaceId]/billing/route.ts`.
 *
 * GET on a brand-new profile returns the column defaults — the row is
 * always present (created during first-org-creation in
 * `app/api/organizations/route.ts`).
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { NotificationRoutingMode } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";

const PatchBodySchema = z
  .object({
    // `defaultLandingOrganizationId: null` clears the preference. The
    // distinction between "key absent" (don't touch) and "key=null"
    // (clear) is preserved via Zod's optional+nullable composition.
    defaultLandingOrganizationId: z.string().min(1).nullable().optional(),
    notificationRoutingMode: z
      .nativeEnum(NotificationRoutingMode)
      .optional(),
    // Light validation only — Intl.NumberFormat will tolerate most BCP-47
    // strings. We reject obvious garbage but don't enumerate every locale.
    locale: z
      .string()
      .min(2)
      .max(35)
      .regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, {
        message: "Locale must be a BCP-47 tag (e.g. en-IN, en-US)",
      })
      .nullable()
      .optional(),
    currencyDisplayCode: z
      .string()
      .regex(/^[A-Z]{3}$/, {
        message: "Currency code must be a 3-letter ISO 4217 string",
      })
      .nullable()
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgWorkspaceId: string }> },
) {
  const { orgWorkspaceId } = await params;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  if (auth.session.user.orgWorkspaceProfileId !== orgWorkspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const profile = await prisma.orgWorkspaceProfile.findUnique({
    where: { id: orgWorkspaceId },
    select: {
      id: true,
      defaultLandingOrganizationId: true,
      notificationRoutingMode: true,
      locale: true,
      currencyDisplayCode: true,
      updatedAt: true,
    },
  });

  if (!profile) {
    return NextResponse.json(
      { error: "OrgWorkspaceProfile not found" },
      { status: 404 },
    );
  }

  // List the caller's ACTIVE OWNER memberships so the UI can render a
  // pick-list for `defaultLandingOrganizationId`. Keeping this on the
  // settings GET (rather than asking the UI to call /organizations
  // separately) keeps the page first-paint cheap.
  const ownedOrgs = await prisma.membership.findMany({
    where: {
      userId: auth.session.user.id,
      role: "OWNER",
      status: "ACTIVE",
    },
    select: {
      organization: {
        select: { id: true, name: true, status: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Filter DEACTIVATED orgs out of the picklist — the operator
  // shouldn't pin a tombstoned org as their landing target.
  const candidateOrgs = ownedOrgs
    .map((m) => m.organization)
    .filter((o) => o.status !== "DEACTIVATED");

  return NextResponse.json({ profile, candidateOrgs });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgWorkspaceId: string }> },
) {
  const { orgWorkspaceId } = await params;
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  if (auth.session.user.orgWorkspaceProfileId !== orgWorkspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Verify `defaultLandingOrganizationId` (when provided + non-null)
  // resolves to an org the caller actually OWNS and is ACTIVE. Without
  // this check an operator could pin an arbitrary org id and the
  // redirect target would surface a 404 they don't recognise.
  if (
    body.defaultLandingOrganizationId !== undefined &&
    body.defaultLandingOrganizationId !== null
  ) {
    const ownership = await prisma.membership.findFirst({
      where: {
        userId: auth.session.user.id,
        organizationId: body.defaultLandingOrganizationId,
        role: "OWNER",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    if (!ownership) {
      return NextResponse.json(
        {
          error:
            "Cannot set default landing org you don't own (or org is inactive).",
          code: "DEFAULT_LANDING_ORG_INVALID",
        },
        { status: 400 },
      );
    }
  }

  const updated = await prisma.orgWorkspaceProfile.update({
    where: { id: orgWorkspaceId },
    data: {
      ...(body.defaultLandingOrganizationId !== undefined && {
        defaultLandingOrganizationId: body.defaultLandingOrganizationId,
      }),
      ...(body.notificationRoutingMode !== undefined && {
        notificationRoutingMode: body.notificationRoutingMode,
      }),
      ...(body.locale !== undefined && { locale: body.locale }),
      ...(body.currencyDisplayCode !== undefined && {
        currencyDisplayCode: body.currencyDisplayCode,
      }),
    },
    select: {
      id: true,
      defaultLandingOrganizationId: true,
      notificationRoutingMode: true,
      locale: true,
      currencyDisplayCode: true,
      updatedAt: true,
    },
  });

  return NextResponse.json({ profile: updated });
}
