import {
  handleGetMaterials,
  handleUploadMaterial,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "webinar",
  planIdField: "webinarPlanId",
  planModel: "webinarPlan",
};

type RouteContext = { params: Promise<{ webinarPlanId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { webinarPlanId } = await params;
  return handleGetMaterials(webinarPlanId, CONFIG);
}

export async function POST(request: Request, { params }: RouteContext) {
  const { webinarPlanId } = await params;
  return handleUploadMaterial(request, webinarPlanId, CONFIG);
}
