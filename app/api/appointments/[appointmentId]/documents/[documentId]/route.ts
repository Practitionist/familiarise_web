import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { deleteAppointmentDocument } from "@/lib/supabase";

// GET - Get specific document details
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string; documentId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId, documentId } = await params;

    // Verify access and get document
    const document = await prisma.appointmentDocument.findFirst({
      where: {
        id: documentId,
        appointmentId,
        appointment: {
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
            // User is part of subscription (consultee)
            {
              subscription: {
                requestedBy: {
                  user: {
                    id: session.user.id
                  }
                }
              }
            },
            // User is part of subscription (consultant)
            {
              subscription: {
                subscriptionPlan: {
                  consultantProfile: {
                    user: {
                      id: session.user.id
                    }
                  }
                }
              }
            }
          ]
        }
      }
    });

    if (!document) {
      return NextResponse.json({ error: "Document not found or access denied" }, { status: 404 });
    }

    return NextResponse.json({ data: document });
  } catch (error) {
    console.error("Error fetching document:", error);
    return NextResponse.json(
      { error: "Failed to fetch document" },
      { status: 500 }
    );
  }
}

// PATCH - Update document review status (consultant only)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string; documentId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId, documentId } = await params;
    const body = await request.json();
    const { reviewStatus, reviewNotes } = body;

    // Verify user is the consultant for this appointment
    const document = await prisma.appointmentDocument.findFirst({
      where: {
        id: documentId,
        appointmentId,
        appointment: {
          OR: [
            // User is the consultant for consultation
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
            // User is the consultant for subscription
            {
              subscription: {
                subscriptionPlan: {
                  consultantProfile: {
                    user: {
                      id: session.user.id
                    }
                  }
                }
              }
            }
          ]
        }
      }
    });

    if (!document) {
      return NextResponse.json({ error: "Document not found or access denied" }, { status: 404 });
    }

    // Valid review statuses
    const validStatuses = ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_REVISION'];
    if (reviewStatus && !validStatuses.includes(reviewStatus)) {
      return NextResponse.json({ error: "Invalid review status" }, { status: 400 });
    }

    // Update document review
    const updatedDocument = await prisma.appointmentDocument.update({
      where: {
        id: documentId
      },
      data: {
        ...(reviewStatus && { reviewStatus }),
        ...(reviewNotes !== undefined && { reviewNotes }),
        ...(reviewStatus && { reviewedAt: new Date() }),
        ...(reviewStatus && { reviewedBy: session.user.id })
      }
    });

    return NextResponse.json({ data: updatedDocument });
  } catch (error) {
    console.error("Error updating document review:", error);
    return NextResponse.json(
      { error: "Failed to update document review" },
      { status: 500 }
    );
  }
}

// DELETE - Delete document (consultee only, and only if not reviewed yet)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string; documentId: string }> }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { appointmentId, documentId } = await params;

    // Verify user is the consultee and document is not yet reviewed
    const document = await prisma.appointmentDocument.findFirst({
      where: {
        id: documentId,
        appointmentId,
        reviewStatus: 'PENDING', // Only allow deletion of pending documents
        appointment: {
          OR: [
            // User is the consultee for consultation
            {
              consultation: {
                requestedBy: {
                  user: {
                    id: session.user.id
                  }
                }
              }
            },
            // User is the consultee for subscription
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
        }
      }
    });

    if (!document) {
      return NextResponse.json({ 
        error: "Document not found, access denied, or already reviewed" 
      }, { status: 404 });
    }

    // Delete from Supabase storage
    const storageDeleted = await deleteAppointmentDocument(document.storagePath);
    if (!storageDeleted) {
      console.warn(`Failed to delete document from storage: ${document.storagePath}`);
    }

    // Delete from database
    await prisma.appointmentDocument.delete({
      where: {
        id: documentId
      }
    });

    return NextResponse.json({ message: "Document deleted successfully" });
  } catch (error) {
    console.error("Error deleting document:", error);
    return NextResponse.json(
      { error: "Failed to delete document" },
      { status: 500 }
    );
  }
} 