import { handleGroupConductRemovalByEvent } from "@/lib/api/participants/group-participants-route";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const { webinarId } = await params;
  return handleGroupConductRemovalByEvent(request, "webinar", webinarId);
}
