import { handleGroupSupportLink } from "@/lib/api/participants/group-participants-route";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const { webinarId } = await params;
  return handleGroupSupportLink("webinar", webinarId);
}
