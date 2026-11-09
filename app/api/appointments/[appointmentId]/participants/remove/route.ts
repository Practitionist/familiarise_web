import { handleGroupConductRemoval } from "@/lib/api/participants/group-participants-route";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const { appointmentId } = await params;
  return handleGroupConductRemoval(request, appointmentId);
}
