import { StreamChat } from "stream-chat";
import { PrismaClient } from "@prisma/client";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_SECRET_KEY;

async function main() {
  if (!apiKey || !apiSecret) {
    console.error("Stream API keys not configured");
    return;
  }

  const prisma = new PrismaClient();
  const serverClient = StreamChat.getInstance(apiKey, apiSecret);

  try {
    // Get a consultant user
    const consultant = await prisma.user.findFirst({
      where: {
        role: "CONSULTANT",
        consultantProfile: {
          isNot: null,
        },
      },
      include: {
        consultantProfile: true,
      },
    });

    if (!consultant) {
      console.error("No consultant found");
      return;
    }

    console.log("Consultant:", consultant.id, consultant.name);

    // Get a consultee user
    const consultee = await prisma.user.findFirst({
      where: {
        role: "CONSULTEE",
        consulteeProfile: {
          isNot: null,
        },
      },
      include: {
        consulteeProfile: true,
      },
    });

    if (!consultee) {
      console.error("No consultee found");
      return;
    }

    console.log("Consultee:", consultee.id, consultee.name);

    // Create a direct message channel between consultant and consultee
    const channelId = [consultant.id, consultee.id].sort().join("-");
    
    console.log("Creating channel with ID:", channelId);
    
    // Create the channel
    const channel = serverClient.channel("messaging", channelId, {
      members: [consultant.id, consultee.id],
      created_by_id: consultant.id,
    });
    
    await channel.create();
    console.log("Channel created:", channel.id);

    // List channels for consultant
    const consultantChannels = await serverClient.queryChannels(
      { members: { $in: [consultant.id] } },
      { last_message_at: -1 },
      { limit: 30 }
    );
    
    console.log(`Found ${consultantChannels.length} channels for consultant`);
    console.log("Channel IDs:", consultantChannels.map(c => c.id));
    console.log("Channel members:", consultantChannels.map(c => Object.keys(c.state.members || {})));

    // List channels for consultee
    const consulteeChannels = await serverClient.queryChannels(
      { members: { $in: [consultee.id] } },
      { last_message_at: -1 },
      { limit: 30 }
    );
    
    console.log(`Found ${consulteeChannels.length} channels for consultee`);
    console.log("Channel IDs:", consulteeChannels.map(c => c.id));
    console.log("Channel members:", consulteeChannels.map(c => Object.keys(c.state.members || {})));

  } catch (error) {
    console.error("Error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
