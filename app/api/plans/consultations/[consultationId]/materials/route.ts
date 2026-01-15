import { NextRequest } from "next/server";
import {
  handleGetMaterials,
  handleUploadMaterial,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "consultation",
  planIdField: "consultationPlanId",
  planModel: "consultationPlan",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> }
) {
  const { consultationId } = await params;
  return handleGetMaterials(request, consultationId, CONFIG);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> }
) {
  const { consultationId } = await params;
  return handleUploadMaterial(request, consultationId, CONFIG);
}
