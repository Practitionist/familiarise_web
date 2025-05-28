import { NextRequest, NextResponse } from "next/server";
import { StreamChat } from "stream-chat";
import prisma from "@/lib/prisma";

const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;
const apiSecret = process.env.STREAM_API_SECRET;

export async function GET(req: NextRequest) {
  try {
    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { success: false, error: "Stream API keys not configured" },
        { status: 500 },
      );
    }

    const serverClient = StreamChat.getInstance(apiKey, apiSecret);

    // Get query parameters
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { success: false, error: "userId is required" },
        { status: 400 },
      );
    }

    // Get user details
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 },
      );
    }

    // Get channels for the user
    const channels = await serverClient.queryChannels(
      { members: { $in: [userId] } },
      { last_message_at: -1 },
      { limit: 30 },
    );

    // Get consultations for the user
    let consultations: any[] = [];
    if (user.consultantProfile) {
      consultations = await prisma.consultation.findMany({
        where: {
          consultationPlan: {
            consultantProfileId: user.consultantProfile.id,
          },
          requestStatus: "APPROVED",
        },
        include: {
          consultationPlan: true,
          requestedBy: {
            include: {
              user: true,
            },
          },
        },
      });
    } else if (user.consulteeProfile) {
      consultations = await prisma.consultation.findMany({
        where: {
          requestedById: user.consulteeProfile.id,
          requestStatus: "APPROVED",
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });
    }

    // Get subscriptions for the user
    let subscriptions: any[] = [];
    if (user.consultantProfile) {
      subscriptions = await prisma.subscription.findMany({
        where: {
          subscriptionPlan: {
            consultantProfileId: user.consultantProfile.id,
          },
          requestStatus: "APPROVED",
        },
        include: {
          subscriptionPlan: true,
          requestedBy: {
            include: {
              user: true,
            },
          },
        },
      });
    } else if (user.consulteeProfile) {
      subscriptions = await prisma.subscription.findMany({
        where: {
          requestedById: user.consulteeProfile.id,
          requestStatus: "APPROVED",
        },
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });
    }

    // Get webinars for the user
    let webinars: any[] = [];
    if (user.consultantProfile) {
      webinars = await prisma.webinar.findMany({
        where: {
          webinarPlan: {
            consultantProfileId: user.consultantProfile.id,
          },
        },
        include: {
          webinarPlan: true,
          waitlist: {
            include: {
              user: true,
            },
          },
        },
      });
    } else {
      webinars = await prisma.webinar.findMany({
        where: {
          waitlist: {
            some: {
              userId: user.id,
            },
          },
        },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });
    }

    // Get classes for the user
    let classes: any[] = [];
    if (user.consultantProfile) {
      classes = await prisma.class.findMany({
        where: {
          classPlan: {
            consultantProfileId: user.consultantProfile.id,
          },
        },
        include: {
          classPlan: true,
          waitlist: {
            include: {
              user: true,
            },
          },
        },
      });
    } else {
      classes = await prisma.class.findMany({
        where: {
          waitlist: {
            some: {
              userId: user.id,
            },
          },
        },
        include: {
          classPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });
    }

    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        consultantProfileId: user.consultantProfileId,
        consulteeProfileId: user.consulteeProfileId,
      },
      channels: channels.map((channel) => {
        const cData = channel.data as Record<string, unknown> | undefined;
        const name = (cData && typeof cData.name === 'string') ? cData.name : undefined;

        return {
          id: channel.id,
          type: channel.type,
          name: name,
          members: Object.keys(channel.state.members || {}),
          memberCount: Object.keys(channel.state.members || {}).length,
          messageCount: channel.state.messages.length,
          lastMessage: channel.lastMessage,
          data: channel.data, // Keep original channel.data if needed elsewhere
        };
      }),
      consultations: consultations.map((consultation) => ({
        id: consultation.id,
        status: consultation.requestStatus,
        consultationPlanId: consultation.consultationPlanId,
        consultationPlanTitle: consultation.consultationPlan.title,
        consultantId: user.consultantProfileId
          ? consultation.requestedBy.user.id
          : consultation.consultationPlan.consultantProfile.user.id,
        consulteeId: user.consultantProfileId
          ? consultation.requestedBy.user.id
          : user.id,
      })),
      subscriptions: subscriptions.map((subscription) => ({
        id: subscription.id,
        status: subscription.requestStatus,
        subscriptionPlanId: subscription.subscriptionPlanId,
        subscriptionPlanTitle: subscription.subscriptionPlan.title,
        consultantId: user.consultantProfileId
          ? user.id
          : subscription.subscriptionPlan.consultantProfile.user.id,
        consulteeId: user.consultantProfileId
          ? subscription.requestedBy.user.id
          : user.id,
      })),
      webinars: webinars.map((webinar) => ({
        id: webinar.id,
        status: webinar.status,
        webinarPlanId: webinar.webinarPlanId,
        webinarPlanTitle: webinar.webinarPlan.title,
        consultantId: user.consultantProfileId
          ? user.id
          : webinar.webinarPlan.consultantProfile.user.id,
        participantIds:
          webinar.waitlist?.map((entry: any) => entry.userId) || [],
      })),
      classes: classes.map((classData) => ({
        id: classData.id,
        status: classData.status,
        classPlanId: classData.classPlanId,
        classPlanTitle: classData.classPlan.title,
        consultantId: user.consultantProfileId
          ? user.id
          : classData.classPlan.consultantProfile.user.id,
        participantIds:
          classData.waitlist?.map((entry: any) => entry.userId) || [],
      })),
    });
  } catch (error) {
    console.error("Error debugging Stream Chat:", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
