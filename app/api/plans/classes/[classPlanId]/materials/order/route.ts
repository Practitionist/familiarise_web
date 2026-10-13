import {
  handleReorderMaterials,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "class",
  planIdField: "classPlanId",
  planModel: "classPlan",
};

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ classPlanId: string }> },
) {
  const { classPlanId } = await params;
  return handleReorderMaterials(request, classPlanId, CONFIG);
}
