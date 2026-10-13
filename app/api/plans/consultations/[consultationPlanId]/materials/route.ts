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

type RouteContext = { params: Promise<{ consultationPlanId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { consultationPlanId } = await params;
  return handleGetMaterials(consultationPlanId, CONFIG);
}

export async function POST(request: Request, { params }: RouteContext) {
  const { consultationPlanId } = await params;
  return handleUploadMaterial(request, consultationPlanId, CONFIG);
}
