import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { uploadAppointmentDocument } from "@/lib/supabase";

// GET - List documents for an appointment
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;

    // Verify user has access to this appointment
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        OR: [
          // User is the consultee
          {
            consultation: {
              requestedBy: {
                user: {
                  id: session.user.id
                }
              }
            }
          },
          // User is the consultant
          {
            consultation: {
              consultationPlan: {
                consultantProfile: {
                  user: {
                    id: session.user.id
                  }
                }
              }
            }
          },
          // User is part of subscription
          {
            subscription: {
              OR: [
                {
                  requestedBy: {
                    user: {
                      id: session.user.id
                    }
                  }
                },
                {
                  subscriptionPlan: {
                    consultantProfile: {
                      user: {
                        id: session.user.id
                      }
                    }
                  }
                }
              ]
            }
          }
        ]
      }
    });

    if (!appointment) {
      return NextResponse.json({ error: "Appointment not found or access denied" }, { status: 404 });
    }

    // Fetch documents
    const documents = await prisma.appointmentDocument.findMany({
      where: {
        appointmentId
      },
      orderBy: {
        uploadedAt: 'desc'
      }
    });

    return NextResponse.json({ data: documents });
  } catch (error) {
    console.error("Error fetching appointment documents:", error);
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 }
    );
  }
}

// POST - Upload a new document
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId } = await params;
    const formData = await request.formData();
    
    const file = formData.get('file') as File;
    const description = formData.get('description') as string;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Verify user has access to this appointment and get consultee ID
    const appointment = await prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        OR: [
          {
            consultation: {
              requestedBy: {
                user: {
                  id: session.user.id
                }
              }
            }
          },
          {
            subscription: {
              requestedBy: {
                user: {
                  id: session.user.id
                }
              }
            }
          }
        ]
      },
      include: {
        consultation: {
          include: {
            requestedBy: {
              include: {
                user: true
              }
            }
          }
        },
        subscription: {
          include: {
            requestedBy: {
              include: {
                user: true
              }
            }
          }
        }
      }
    });

    if (!appointment) {
      return NextResponse.json({ error: "Appointment not found or access denied" }, { status: 404 });
    }

    // Get consultee ID from appointment
    const consulteeId = appointment.consultation?.requestedBy?.id || 
                       appointment.subscription?.requestedBy?.id;

    if (!consulteeId) {
      return NextResponse.json({ error: "Unable to determine consultee" }, { status: 400 });
    }

    // Upload file to Supabase
    const uploadResult = await uploadAppointmentDocument({
      appointmentId,
      consulteeId,
      description,
      file
    });

    if (!uploadResult.success) {
      return NextResponse.json({ error: uploadResult.error }, { status: 400 });
    }

    // Save document record to database
    const document = await prisma.appointmentDocument.create({
      data: {
        appointmentId,
        fileName: uploadResult.fileName!,
        originalName: file.name,
        fileSize: uploadResult.fileSize!,
        mimeType: uploadResult.mimeType!,
        fileUrl: uploadResult.fileUrl!,
        storagePath: uploadResult.storagePath!,
        description: description || null,
        reviewStatus: 'PENDING'
      }
    });

    return NextResponse.json({ data: document }, { status: 201 });
  } catch (error) {
    console.error("Error uploading document:", error);
    return NextResponse.json(
      { error: "Failed to upload document" },
      { status: 500 }
    );
  }
} 