/**
 * Org image upload — logo and banner.
 *
 * POST — ORG_ADMIN+. Accepts a multipart FormData with:
 *   - `file`: the image file (JPEG/PNG/WebP, max 5MB)
 *   - `type`: "logo" | "banner"
 *
 * Uploads to Supabase bucket "organizations" at path `{orgId}/{type}.{ext}`.
 * Updates the Organization.logo (for logos) or OrganizationProfile fields.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  uploadToSupabase,
  generateStorageFileName,
} from "@/lib/supabase";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const type = formData.get("type") as string | null;

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 },
      );
    }
    if (!type || (type !== "logo" && type !== "banner")) {
      return NextResponse.json(
        { error: 'type must be "logo" or "banner"' },
        { status: 400 },
      );
    }
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Only JPEG, PNG, and WebP images are accepted" },
        { status: 400 },
      );
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File must be under 5MB" },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = generateStorageFileName(file.type);
    const storagePath = `${orgId}/${type}-${fileName}`;

    const { url, error: uploadError } = await uploadToSupabase(
      storagePath,
      buffer,
      file.type,
      "organizations",
    );

    if (uploadError || !url) {
      return NextResponse.json(
        { error: uploadError || "Upload failed" },
        { status: 500 },
      );
    }

    // Update the org record with the new URL.
    if (type === "logo") {
      await prisma.$transaction([
        prisma.organization.update({
          where: { id: orgId },
          data: { logo: url },
        }),
        prisma.organizationProfile.update({
          where: { id: access.org.id },
          data: { logo: url },
        }),
      ]);
    } else {
      await prisma.organizationProfile.update({
        where: { id: access.org.id },
        data: { bannerImage: url },
      });
    }

    return NextResponse.json({ url, type });
  } catch (error) {
    console.error("[API /organizations/[orgId]/images POST] error:", error);
    return NextResponse.json(
      { error: "Failed to upload image" },
      { status: 500 },
    );
  }
}
