import {
  handleDeleteMaterial,
  handleReplaceMaterial,
  handleUpdateMaterial,
} from "@/app/api/plans/shared/materials-handler";

type RouteContext = { params: Promise<{ materialId: string }> };

/** Rename a material or edit its description. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { materialId } = await params;
  return handleUpdateMaterial(request, materialId);
}

/** Replace a material's file, keeping its name, description and order. */
export async function PUT(request: Request, { params }: RouteContext) {
  const { materialId } = await params;
  return handleReplaceMaterial(request, materialId);
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { materialId } = await params;
  return handleDeleteMaterial(materialId);
}
