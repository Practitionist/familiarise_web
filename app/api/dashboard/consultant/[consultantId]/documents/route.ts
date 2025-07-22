import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

// GET - Get all documents for review by consultant
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consultantId } = await params;
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const appointmentType = searchParams.get('appointmentType');

    // Verify user is the consultant
    const consultant = await prisma.consultantProfile.findFirst({
      where: {
        id: consultantId,
        user: {
          id: session.user.id
        }
      }
    });

    if (!consultant) {
      return NextResponse.json({ error: "Consultant not found or access denied" }, { status: 404 });
    }

    // Build where clause
    const where: any = {
      appointment: {
        OR: [
          // Consultation appointments
          {
            consultation: {
              consultationPlan: {
                consultantProfileId: consultantId
              }
            }
          },
          // Subscription appointments  
          {
            subscription: {
              subscriptionPlan: {
                consultantProfileId: consultantId
              }
            }
          }
        ]
      }
    };

    // Add status filter
    if (status) {
      where.reviewStatus = status;
    }

    // Add appointment type filter
    if (appointmentType) {
      if (appointmentType === 'Consultation') {
        where.appointment.consultation = { isNot: null };
        where.appointment.subscription = null;
      } else if (appointmentType === 'Subscription') {
        where.appointment.subscription = { isNot: null };
        where.appointment.consultation = null;
      }
    }

    // Fetch documents with includes for display
    const documents = await prisma.appointmentDocument.findMany({
      where,
      include: {
        appointment: {
          include: {
            consultation: {
              include: {
                requestedBy: {
                  include: {
                    user: true
                  }
                },
                consultationPlan: true
              }
            },
            subscription: {
              include: {
                requestedBy: {
                  include: {
                    user: true
                  }
                },
                subscriptionPlan: true
              }
            }
          }
        }
      },
      orderBy: {
        uploadedAt: 'desc'
      }
    });

    // Transform data for frontend
    const transformedDocuments = documents.map((doc) => {
      const appointment = doc.appointment;
      const consultation = appointment.consultation;
      const subscription = appointment.subscription;
      
      // Determine client info and appointment details
      let clientName = '';
      let clientId = '';
      let appointmentTitle = '';
      let appointmentType = '';

      if (consultation) {
        clientName = consultation.requestedBy.user.name || 'Unknown';
        clientId = consultation.requestedBy.user.id;
        appointmentTitle = consultation.consultationPlan.title;
        appointmentType = 'Consultation';
      } else if (subscription) {
        clientName = subscription.requestedBy.user.name || 'Unknown';
        clientId = subscription.requestedBy.user.id;
        appointmentTitle = subscription.subscriptionPlan.title;
        appointmentType = 'Subscription';
      }

      return {
        id: doc.id,
        appointmentId: doc.appointmentId,
        fileName: doc.fileName,
        originalName: doc.originalName,
        fileSize: doc.fileSize,
        mimeType: doc.mimeType,
        fileUrl: doc.fileUrl,
        description: doc.description,
        reviewStatus: doc.reviewStatus,
        reviewNotes: doc.reviewNotes,
        reviewedAt: doc.reviewedAt,
        uploadedAt: doc.uploadedAt,
        clientName,
        clientId,
        appointmentTitle,
        appointmentType,
        // Legacy fields for existing UI compatibility
        title: doc.originalName,
        invoiceNo: `DOC-${doc.id.slice(-8)}`,
        tag: doc.reviewStatus
      };
    });

    return NextResponse.json({ data: transformedDocuments });
  } catch (error) {
    console.error("Error fetching consultant documents:", error);
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 }
    );
  }
} 