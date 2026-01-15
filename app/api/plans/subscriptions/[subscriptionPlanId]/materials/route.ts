import { NextRequest } from "next/server";
import {
  handleGetMaterials,
  handleUploadMaterial,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "subscription",
  planIdField: "subscriptionPlanId",
  planModel: "subscriptionPlan",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> }
) {
  const { subscriptionPlanId } = await params;
  return handleGetMaterials(request, subscriptionPlanId, CONFIG);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionPlanId: string }> }
) {
  const { subscriptionPlanId } = await params;
  return handleUploadMaterial(request, subscriptionPlanId, CONFIG);
}
