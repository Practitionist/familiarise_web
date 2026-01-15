import { NextRequest } from "next/server";
import {
  handleGetMaterials,
  handleUploadMaterial,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "class",
  planIdField: "classPlanId",
  planModel: "classPlan",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ classPlanId: string }> }
) {
  const { classPlanId } = await params;
  return handleGetMaterials(request, classPlanId, CONFIG);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ classPlanId: string }> }
) {
  const { classPlanId } = await params;
  return handleUploadMaterial(request, classPlanId, CONFIG);
}
