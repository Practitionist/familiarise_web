/**
 * Org payout account (PROVIDER feature) — GET / PUT / DELETE.
 *
 * All gated behind ENABLE_PROVIDER_ORGS. Returns 501 with the flag name when
 * disabled. The full implementation lives behind the flag and ships when the
 * first PROVIDER customer arrives — see Issue #646.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";

function notImplemented() {
  return NextResponse.json(
    {
      error: "PROVIDER organization payout accounts are not yet available.",
      flag: "ENABLE_PROVIDER_ORGS",
    },
    { status: 501 },
  );
}

const putAccountSchema = z.object({
  accountHolderName: z.string().min(2).max(100),
  accountNumber: z.string().min(4).max(50),
  bankName: z.string().min(2).max(100),
  ifscCode: z.string().min(4).max(20).optional(),
  routingNumber: z.string().optional(),
  swiftCode: z.string().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) return notImplemented();

  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "ORG_OWNER");
  if (access.error) return access.error;

  const account = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationProfileId: access.org.id },
  });
  return NextResponse.json({ account });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) return notImplemented();

  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "ORG_OWNER");
  if (access.error) return access.error;

  const body = await req.json();
  const parsed = putAccountSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { accountNumber, ...rest } = parsed.data;
  // STUB encryption — Issue #646 covers replacing this with libsodium / KMS.
  const accountNumberEncrypted = Buffer.from(accountNumber).toString("base64");
  const accountNumberLast4 = accountNumber.slice(-4);

  const account = await prisma.organizationPayoutAccount.upsert({
    where: { organizationProfileId: access.org.id },
    create: {
      organizationProfileId: access.org.id,
      accountNumberEncrypted,
      accountNumberLast4,
      ...rest,
    },
    update: {
      accountNumberEncrypted,
      accountNumberLast4,
      ...rest,
    },
  });

  return NextResponse.json({ account });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) return notImplemented();

  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "ORG_OWNER");
  if (access.error) return access.error;

  await prisma.organizationPayoutAccount
    .delete({
      where: { organizationProfileId: access.org.id },
    })
    .catch(() => null); // idempotent — silently no-op if absent

  return NextResponse.json({ success: true });
}
