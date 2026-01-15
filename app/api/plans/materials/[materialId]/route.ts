import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import {
  handleDeleteMaterial,
  handleUpdateMaterial,
} from "@/app/api/plans/shared/materials-handler";

// GET - Get a single material by ID
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        {
          error: "Authentication required",
          message: "Please sign in to view material",
          code: "UNAUTHORIZED",
        },
        { status: 401 }
      );
    }

    const { materialId } = await params;

    const material = await prisma.planMaterial.findUnique({
      where: { id: materialId },
    });

    if (!material) {
      return NextResponse.json(
        {
          error: "Material not found",
          message: "The requested material does not exist",
          code: "NOT_FOUND",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: material });
  } catch (error) {
    console.error("Error fetching material:", error);
    return NextResponse.json(
      {
        error: "Server error",
        message: "Failed to fetch material",
        code: "SERVER_ERROR",
      },
      { status: 500 }
    );
  }
}

// PATCH - Update material (order, description)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  const { materialId } = await params;
  return handleUpdateMaterial(request, materialId);
}

// DELETE - Delete material
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  const { materialId } = await params;
  return handleDeleteMaterial(request, materialId);
}
