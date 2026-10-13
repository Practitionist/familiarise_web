import {
  handleMaterialUploadUrl,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "webinar",
  planIdField: "webinarPlanId",
  planModel: "webinarPlan",
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  const { webinarPlanId } = await params;
  return handleMaterialUploadUrl(request, webinarPlanId, CONFIG);
}
