import { NextRequest } from "next/server";
import {
  handleGetMaterials,
  handleUploadMaterial,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "class",
  planIdField: "cohortPlanId",
  planModel: "cohortPlan",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ cohortPlanId: string }> },
) {
  const { cohortPlanId } = await params;
  return handleGetMaterials(request, cohortPlanId, CONFIG);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ cohortPlanId: string }> },
) {
  const { cohortPlanId } = await params;
  return handleUploadMaterial(request, cohortPlanId, CONFIG);
}
