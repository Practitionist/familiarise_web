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

type RouteContext = { params: Promise<{ subscriptionPlanId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { subscriptionPlanId } = await params;
  return handleGetMaterials(subscriptionPlanId, CONFIG);
}

export async function POST(request: Request, { params }: RouteContext) {
  const { subscriptionPlanId } = await params;
  return handleUploadMaterial(request, subscriptionPlanId, CONFIG);
}
