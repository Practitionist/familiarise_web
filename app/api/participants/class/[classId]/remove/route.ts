import { handleGroupConductRemovalByEvent } from "@/lib/api/participants/group-participants-route";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const { classId } = await params;
  return handleGroupConductRemovalByEvent(request, "class", classId);
}
