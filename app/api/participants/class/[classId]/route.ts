import { removeUserFromEventChannel } from "@/actions/stream/chat/event-channel.action";
import {
  handleGroupParticipantDelete,
  handleGroupParticipantsGet,
} from "@/lib/api/participants/group-participants-route";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const { classId } = await params;
  return handleGroupParticipantsGet(request, "class", classId);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ classId: string }> },
) {
  const { classId } = await params;
  return handleGroupParticipantDelete(request, "class", classId, (userId) =>
    removeUserFromEventChannel("class", classId, userId),
  );
}
