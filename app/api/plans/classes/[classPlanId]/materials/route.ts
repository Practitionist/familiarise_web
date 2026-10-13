import {
  handleGetMaterials,
  handleUploadMaterial,
  type PlanMaterialsConfig,
} from "@/app/api/plans/shared/materials-handler";

const CONFIG: PlanMaterialsConfig = {
  planType: "class",
  planIdField: "classPlanId",
  planModel: "classPlan",
};

type RouteContext = { params: Promise<{ classPlanId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const { classPlanId } = await params;
  return handleGetMaterials(classPlanId, CONFIG);
}

export async function POST(request: Request, { params }: RouteContext) {
  const { classPlanId } = await params;
  return handleUploadMaterial(request, classPlanId, CONFIG);
}
