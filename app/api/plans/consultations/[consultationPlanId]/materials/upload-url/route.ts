import {
  handleMaterialUploadUrl,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "consultation",
  planIdField: "consultationPlanId",
  planModel: "consultationPlan",
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ consultationPlanId: string }> },
) {
  const { consultationPlanId } = await params;
  return handleMaterialUploadUrl(request, consultationPlanId, CONFIG);
}
