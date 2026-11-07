import { getClassPlanDetail } from "@/lib/data/plan-details";
import { canViewPlanDetail } from "@/lib/data/plan-viewable";
import {
  SHARE_IMAGE_CONTENT_TYPE,
  SHARE_IMAGE_SIZE,
  renderEventPlanShareImage,
} from "@/lib/seo/event-plan-share-image";

// Read at request time: the plan may not exist, or be published, at build.
export const dynamic = "force-dynamic";
export const alt = "Live class on Familiarise";
export const size = SHARE_IMAGE_SIZE;
export const contentType = SHARE_IMAGE_CONTENT_TYPE;

export default async function ClassShareImage({
  params,
}: Readonly<{ params: Promise<{ classPlanId: string }> }>) {
  const { classPlanId } = await params;
  const plan = await getClassPlanDetail(classPlanId).catch(() => null);
  // Anonymous gate: the image URL is public and cached, so only a plan anyone
  // may see names itself in it. A hidden plan gets the generic card.
  const visible = plan && (await canViewPlanDetail(plan, null)) ? plan : null;
  return renderEventPlanShareImage({
    kind: "class",
    title: visible?.title ?? null,
    host: visible?.consultantProfile?.user?.name ?? null,
  });
}
