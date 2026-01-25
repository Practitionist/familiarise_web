import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import {
  uploadCoverImage,
  deleteCoverImage,
  ALLOWED_COVER_IMAGE_TYPES,
  COVER_IMAGE_MAX_SIZE,
} from "@/lib/supabase";

/**
 * POST /api/user/cover-image
 * Upload a cover image for the authenticated user
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const userId = formData.get("userId") as string | null;

    // Verify the user is uploading their own cover image
    if (userId && userId !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    if (!file) {
      return NextResponse.json(
        { success: false, error: "No file provided" },
        { status: 400 },
      );
    }

    // Validate file type
    if (!ALLOWED_COVER_IMAGE_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid file type. Please upload a JPEG, PNG, or WebP image.",
        },
        { status: 400 },
      );
    }

    // Validate file size
    if (file.size > COVER_IMAGE_MAX_SIZE) {
      return NextResponse.json(
        { success: false, error: "File size exceeds 5MB limit" },
        { status: 400 },
      );
    }

    // Upload to Supabase
    const uploadResult = await uploadCoverImage({
      userId: session.user.id,
      file,
    });

    if (!uploadResult.success || !uploadResult.fileUrl) {
      return NextResponse.json(
        { success: false, error: uploadResult.error || "Upload failed" },
        { status: 500 },
      );
    }

    // Update user record with cover image URL
    await prisma.user.update({
      where: { id: session.user.id },
      data: { coverImage: uploadResult.fileUrl },
    });

    return NextResponse.json({
      success: true,
      data: {
        coverImage: uploadResult.fileUrl,
        storagePath: uploadResult.storagePath,
      },
    });
  } catch (error) {
    console.error("Cover image upload error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to upload cover image",
      },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/user/cover-image
 * Delete the cover image for the authenticated user
 */
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    // Verify the user is deleting their own cover image
    if (userId && userId !== session.user.id) {
      return NextResponse.json(
        { success: false, error: "Forbidden" },
        { status: 403 },
      );
    }

    // Check if user has a cover image
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { coverImage: true },
    });

    if (!user?.coverImage) {
      return NextResponse.json({
        success: true,
        message: "No cover image to delete",
      });
    }

    // Delete from Supabase
    const deleteResult = await deleteCoverImage(session.user.id);

    if (!deleteResult) {
      console.warn("Failed to delete cover image from storage");
      // Continue anyway to clear the database reference
    }

    // Update user record to remove cover image URL
    await prisma.user.update({
      where: { id: session.user.id },
      data: { coverImage: null },
    });

    return NextResponse.json({
      success: true,
      message: "Cover image deleted successfully",
    });
  } catch (error) {
    console.error("Cover image delete error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to delete cover image",
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/user/cover-image
 * Get the cover image URL for a user
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "User ID is required" },
        { status: 400 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { coverImage: true },
    });

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: { coverImage: user.coverImage },
    });
  } catch (error) {
    console.error("Get cover image error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to get cover image",
      },
      { status: 500 },
    );
  }
}
