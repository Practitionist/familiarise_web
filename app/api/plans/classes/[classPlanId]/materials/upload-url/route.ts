import {
  handleMaterialUploadUrl,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "class",
  planIdField: "classPlanId",
  planModel: "classPlan",
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classPlanId: string }> },
) {
  const { classPlanId } = await params;
  return handleMaterialUploadUrl(request, classPlanId, CONFIG);
}
