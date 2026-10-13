import {
  handleReorderMaterials,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "subscription",
  planIdField: "subscriptionPlanId",
  planModel: "subscriptionPlan",
};

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ subscriptionPlanId: string }> },
) {
  const { subscriptionPlanId } = await params;
  return handleReorderMaterials(request, subscriptionPlanId, CONFIG);
}
