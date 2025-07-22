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
      return NextResponse.json(
        { 
          error: "Authentication required", 
          message: "Please sign in to view documents for review",
          code: "UNAUTHORIZED"
        }, 
        { status: 401 }
      );
    }

    const { consultantId } = await params;
    
    if (!consultantId) {
      return NextResponse.json(
        { 
          error: "Invalid consultant", 
          message: "Consultant ID is required",
          code: "INVALID_INPUT"
        }, 
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const appointmentType = searchParams.get('appointmentType');

    // Verify user is the consultant with enhanced error handling
    let consultant;
    try {
      // In development mode, allow access to any consultant's documents for testing
      const isDevelopment = process.env.NODE_ENV === 'development';
      
      const consultantWhereClause: any = {
        id: consultantId
      };

      if (!isDevelopment) {
        consultantWhereClause.user = {
          id: session.user.id
        };
      }

      consultant = await prisma.consultantProfile.findFirst({
        where: consultantWhereClause,
        include: {
          user: {
            select: { name: true, email: true }
          }
        }
      });

      // In development mode, log access bypass
      if (isDevelopment && consultant) {
        console.log(`[DEV MODE] Bypassing consultant access control for ${consultantId}`);
      }
    } catch (dbError) {
      console.error("Database error fetching consultant:", dbError);
      return NextResponse.json(
        {
          error: "Database temporarily unavailable",
          message: "Unable to verify consultant access. Please try again in a few moments.",
          code: "DATABASE_ERROR"
        },
        { status: 503 }
      );
    }

    if (!consultant) {
      return NextResponse.json(
        { 
          error: "Access denied", 
          message: process.env.NODE_ENV === 'development'
            ? `[DEV MODE] Consultant profile ${consultantId} not found in database.`
            : "You don't have permission to view documents for this consultant profile. Please check that you're accessing the correct consultant dashboard.",
          code: "ACCESS_DENIED"
        }, 
        { status: 403 }
      );
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

    // Add status filter with validation
    if (status) {
      const validStatuses = ['PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'NEEDS_REVISION'];
      if (validStatuses.includes(status)) {
        where.reviewStatus = status;
      } else {
        return NextResponse.json(
          {
            error: "Invalid status filter",
            message: `Status "${status}" is not valid. Valid statuses are: ${validStatuses.join(', ')}`,
            code: "INVALID_FILTER"
          },
          { status: 400 }
        );
      }
    }

    // Add appointment type filter with validation
    if (appointmentType) {
      const validTypes = ['Consultation', 'Subscription'];
      if (!validTypes.includes(appointmentType)) {
        return NextResponse.json(
          {
            error: "Invalid appointment type filter",
            message: `Appointment type "${appointmentType}" is not valid. Valid types are: ${validTypes.join(', ')}`,
            code: "INVALID_FILTER"
          },
          { status: 400 }
        );
      }

      if (appointmentType === 'Consultation') {
        where.appointment.consultation = { isNot: null };
        where.appointment.subscription = null;
      } else if (appointmentType === 'Subscription') {
        where.appointment.subscription = { isNot: null };
        where.appointment.consultation = null;
      }
    }

    // Fetch documents with enhanced error handling
    let documents;
    try {
      documents = await prisma.appointmentDocument.findMany({
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
    } catch (dbError) {
      console.error("Database error fetching documents:", dbError);
      
      // Return empty array with helpful message instead of failing
      return NextResponse.json(
        {
          data: [],
          count: 0,
          message: "Unable to load documents at the moment. This might be because no documents have been uploaded yet, or there's a temporary system issue. Please try again later.",
          consultant: consultant.user.name,
          filters: {
            status,
            appointmentType
          }
        }
      );
    }

    // Transform data for frontend with error resilience
    const transformedDocuments = documents.map((doc) => {
      try {
        const appointment = doc.appointment;
        const consultation = appointment.consultation;
        const subscription = appointment.subscription;
        
        // Determine client info and appointment details with fallbacks
        let clientName = 'Unknown Client';
        let clientId = '';
        let appointmentTitle = 'Unknown Appointment';
        let appointmentType = 'Unknown';

        if (consultation) {
          clientName = consultation.requestedBy?.user?.name || 'Unknown Client';
          clientId = consultation.requestedBy?.user?.id || '';
          appointmentTitle = consultation.consultationPlan?.title || 'Consultation';
          appointmentType = 'Consultation';
        } else if (subscription) {
          clientName = subscription.requestedBy?.user?.name || 'Unknown Client';
          clientId = subscription.requestedBy?.user?.id || '';
          appointmentTitle = subscription.subscriptionPlan?.title || 'Subscription';
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
      } catch (transformError) {
        console.error("Error transforming document:", transformError, doc);
        
        // Return a safe fallback version of the document
        return {
          id: doc.id || 'unknown',
          appointmentId: doc.appointmentId || 'unknown',
          fileName: doc.fileName || 'Unknown File',
          originalName: doc.originalName || 'Unknown Document',
          fileSize: doc.fileSize || 0,
          mimeType: doc.mimeType || 'application/octet-stream',
          fileUrl: doc.fileUrl || '',
          description: doc.description || null,
          reviewStatus: doc.reviewStatus || 'PENDING',
          reviewNotes: doc.reviewNotes || null,
          reviewedAt: doc.reviewedAt || null,
          uploadedAt: doc.uploadedAt || new Date(),
          clientName: 'Unknown Client',
          clientId: '',
          appointmentTitle: 'Unknown Appointment',
          appointmentType: 'Unknown',
          // Legacy fields
          title: doc.originalName || 'Unknown Document',
          invoiceNo: `DOC-${(doc.id || 'unknown').slice(-8)}`,
          tag: doc.reviewStatus || 'PENDING'
        };
      }
    });

    // Provide helpful context messages
    let message = '';
    const totalCount = transformedDocuments.length;
    const isDevelopment = process.env.NODE_ENV === 'development';
    const devModeMessage = isDevelopment ? " [DEV MODE - Access control bypassed]" : "";
    
    if (totalCount === 0) {
      if (status || appointmentType) {
        message = `No documents found with the applied filters. Try removing some filters to see more documents.${devModeMessage}`;
      } else {
        message = `No documents have been submitted for review yet. Documents will appear here when clients upload files for their appointments.${devModeMessage}`;
      }
    } else {
      const filterText = [];
      if (status) filterText.push(`status: ${status}`);
      if (appointmentType) filterText.push(`type: ${appointmentType}`);
      
      const filterSuffix = filterText.length > 0 ? ` (filtered by ${filterText.join(', ')})` : '';
      message = `Found ${totalCount} document${totalCount === 1 ? '' : 's'} for review${filterSuffix}.${devModeMessage}`;
    }

    return NextResponse.json(
      { 
        data: transformedDocuments,
        count: totalCount,
        message,
        consultant: isDevelopment ? `${consultant.user.name} [DEV MODE]` : consultant.user.name,
        filters: {
          status,
          appointmentType
        },
        metadata: {
          pendingCount: transformedDocuments.filter(d => d.reviewStatus === 'PENDING').length,
          reviewingCount: transformedDocuments.filter(d => d.reviewStatus === 'IN_REVIEW').length,
          completedCount: transformedDocuments.filter(d => ['APPROVED', 'REJECTED'].includes(d.reviewStatus)).length
        }
      }
    );
  } catch (error) {
    console.error("Error fetching consultant documents:", error);
    
    // Provide specific error messages based on error type
    if (error instanceof Error) {
      if (error.message.includes("connect") || error.message.includes("timeout")) {
        return NextResponse.json(
          {
            error: "Connection error",
            message: "Unable to connect to the document system. Please check your internet connection and try again.",
            code: "CONNECTION_ERROR"
          },
          { status: 503 }
        );
      }
      
      if (error.message.includes("Prisma") || error.message.includes("database")) {
        return NextResponse.json(
          {
            error: "Database temporarily unavailable",
            message: "The document review system is temporarily unavailable. Please try again in a few moments.",
            code: "DATABASE_ERROR"
          },
          { status: 503 }
        );
      }
    }

    return NextResponse.json(
      {
        error: "Unable to load documents",
        message: "Something went wrong while loading documents for review. Please refresh the page or try again later. If the problem persists, contact support.",
        code: "UNKNOWN_ERROR"
      },
      { status: 500 }
    );
  }
} 