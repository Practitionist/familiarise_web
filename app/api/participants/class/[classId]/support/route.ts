import { handleGroupSupportLink } from "@/lib/api/participants/group-participants-route";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const { classId } = await params;
  return handleGroupSupportLink("class", classId);
}
