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

    // Get webinars for the user (BOTH waitlist AND appointment participation)
    let webinars: any[] = [];
    if (user.consultantProfile) {
      // For consultants, get webinars they host
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
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });
    } else {
      // For consultees, get webinars from both waitlist AND appointments
      const webinarsFromWaitlist = await prisma.webinar.findMany({
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
          waitlist: {
            include: {
              user: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });

      const webinarsFromAppointments = await prisma.webinar.findMany({
        where: {
          appointment: {
            slotsOfAppointment: {
              some: {
                user: {
                  some: {
                    id: user.id,
                  },
                },
              },
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
          waitlist: {
            include: {
              user: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });

      // Combine and deduplicate
      const allWebinarIds = Array.from(new Set([
        ...webinarsFromWaitlist.map(w => w.id),
        ...webinarsFromAppointments.map(w => w.id)
      ]));
      
      // Merge webinars, preferring the one with more complete data
      const webinarMap = new Map();
      [...webinarsFromWaitlist, ...webinarsFromAppointments].forEach(webinar => {
        webinarMap.set(webinar.id, webinar);
      });
      
      webinars = Array.from(webinarMap.values());
    }

    // Get classes for the user (BOTH waitlist AND appointment participation)
    let classes: any[] = [];
    if (user.consultantProfile) {
      // For consultants, get classes they host
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
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });
    } else {
      // For consultees, get classes from both waitlist AND appointments
      const classesFromWaitlist = await prisma.class.findMany({
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
          waitlist: {
            include: {
              user: true,
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });

      const classesFromAppointments = await prisma.class.findMany({
        where: {
          appointments: {
            some: {
              slotsOfAppointment: {
                some: {
                  user: {
                    some: {
                      id: user.id,
                    },
                  },
                },
              },
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
          waitlist: {
            include: {
              user: true,
            },
          },
          appointments: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });

      // Combine and deduplicate
      const allClassIds = Array.from(new Set([
        ...classesFromWaitlist.map(c => c.id),
        ...classesFromAppointments.map(c => c.id)
      ]));
      
      // Merge classes, preferring the one with more complete data
      const classMap = new Map();
      [...classesFromWaitlist, ...classesFromAppointments].forEach(classData => {
        classMap.set(classData.id, classData);
      });
      
      classes = Array.from(classMap.values());
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
      channels: channels.map((channel) => ({
        id: channel.id,
        type: channel.type,
        name: channel.data?.name,
        members: Object.keys(channel.state.members || {}),
        memberCount: Object.keys(channel.state.members || {}).length,
        messageCount: channel.state.messages.length,
        lastMessage: channel.lastMessage,
        data: channel.data,
      })),
      consultations: consultations.map((consultation) => ({
        id: consultation.id,
        status: consultation.requestStatus,
        consultationPlanId: consultation.consultationPlanId,
        consultationPlanTitle: consultation.consultationPlan?.title || 'Unknown',
        consultantId: user.consultantProfileId
          ? consultation.requestedBy?.user?.id || 'Unknown'
          : consultation.consultationPlan?.consultantProfile?.user?.id || 'Unknown',
        consulteeId: user.consultantProfileId
          ? consultation.requestedBy?.user?.id || 'Unknown'
          : user.id,
      })),
      subscriptions: subscriptions.map((subscription) => ({
        id: subscription.id,
        status: subscription.requestStatus,
        subscriptionPlanId: subscription.subscriptionPlanId,
        subscriptionPlanTitle: subscription.subscriptionPlan?.title || 'Unknown',
        consultantId: user.consultantProfileId
          ? user.id
          : subscription.subscriptionPlan?.consultantProfile?.user?.id || 'Unknown',
        consulteeId: user.consultantProfileId
          ? subscription.requestedBy?.user?.id || 'Unknown'
          : user.id,
      })),
      webinars: webinars.map((webinar) => {
        const waitlistParticipantIds = webinar.waitlist?.map((entry: any) => entry.userId) || [];
        const appointmentParticipantIds = webinar.appointment?.slotsOfAppointment?.flatMap(
          (slot: any) => slot.user.map((user: any) => user.id)
        ) || [];
        const allParticipantIds = Array.from(new Set([...waitlistParticipantIds, ...appointmentParticipantIds]));
        
        return {
          id: webinar.id,
          status: webinar.status,
          webinarPlanId: webinar.webinarPlanId,
          webinarPlanTitle: webinar.webinarPlan?.title || 'Unknown',
          consultantId: user.consultantProfileId
            ? user.id
            : webinar.webinarPlan?.consultantProfile?.user?.id || 'Unknown',
          participantIds: allParticipantIds,
          waitlistParticipantIds,
          appointmentParticipantIds,
          participantBreakdown: {
            fromWaitlist: waitlistParticipantIds.length,
            fromAppointments: appointmentParticipantIds.length,
            totalUnique: allParticipantIds.length
          }
        };
      }),
      classes: classes.map((classData) => {
        const waitlistParticipantIds = classData.waitlist?.map((entry: any) => entry.userId) || [];
        const appointmentParticipantIds = classData.appointments?.flatMap(
          (appointment: any) => appointment.slotsOfAppointment?.flatMap(
            (slot: any) => slot.user.map((user: any) => user.id)
          )
        ) || [];
        const allParticipantIds = Array.from(new Set([...waitlistParticipantIds, ...appointmentParticipantIds]));
        
        return {
          id: classData.id,
          status: classData.status,
          classPlanId: classData.classPlanId,
          classPlanTitle: classData.classPlan?.title || 'Unknown',
          consultantId: user.consultantProfileId
            ? user.id
            : classData.classPlan?.consultantProfile?.user?.id || 'Unknown',
          participantIds: allParticipantIds,
          waitlistParticipantIds,
          appointmentParticipantIds,
          participantBreakdown: {
            fromWaitlist: waitlistParticipantIds.length,
            fromAppointments: appointmentParticipantIds.length,
            totalUnique: allParticipantIds.length
          }
        };
      }),
    });
  } catch (error) {
    console.error("Error debugging Stream Chat:", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 },
    );
  }
}
