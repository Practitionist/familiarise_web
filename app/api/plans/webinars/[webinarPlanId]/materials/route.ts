import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  const { webinarPlanId } = await params;
  return handleGetMaterials(request, webinarPlanId, CONFIG);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ webinarPlanId: string }> },
) {
  const { webinarPlanId } = await params;
  return handleUploadMaterial(request, webinarPlanId, CONFIG);
}
