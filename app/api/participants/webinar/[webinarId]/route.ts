import { removeUserFromEventChannel } from "@/actions/stream/chat/event-channel.action";
import {
  handleGroupParticipantDelete,
  handleGroupParticipantsGet,
} from "@/lib/api/participants/group-participants-route";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const { webinarId } = await params;
  return handleGroupParticipantsGet(request, "webinar", webinarId);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const { webinarId } = await params;
  return handleGroupParticipantDelete(request, "webinar", webinarId, (userId) =>
    removeUserFromEventChannel("webinar", webinarId, userId),
  );
}
