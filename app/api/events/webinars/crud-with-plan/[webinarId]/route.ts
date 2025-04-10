import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Basic validation for UUID
const uuidSchema = z.string().uuid();

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> }, // Use Promise for params
) {
  try {
    // Add session check if needed
    // const session = await getServerSession(authOptions);
    // if (!session) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const awaitedParams = await params; // Await the promise
    const { webinarId } = awaitedParams;

    // Validate the extracted ID
    const validationResult = uuidSchema.safeParse(webinarId);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Invalid Webinar ID format" },
        { status: 400 },
      );
    }

    console.log(`Attempting to delete webinar instance with ID: ${webinarId}`);

    // Start transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // 1. Find the webinar instance to get the plan ID
        const webinarInstance = await tx.webinar.findUnique({
          where: { id: webinarId },
          select: { webinarPlanId: true }, // Only need the plan ID
        });

        if (!webinarInstance) {
          throw new Error(`Webinar instance with ID ${webinarId} not found.`);
        }

        const webinarPlanId = webinarInstance.webinarPlanId;
        console.log(
          `Found webinar plan ID: ${webinarPlanId} for instance ${webinarId}`,
        );

        // 2. Delete the webinar instance
        // Note: Prisma cascade delete should handle related appointment/slots/meetingRoom/waitlist
        console.log(`Deleting webinar instance: ${webinarId}`);
        await tx.webinar.delete({
          where: { id: webinarId },
        });

        // 3. Check if other webinar instances use the same plan
        const remainingInstancesCount = await tx.webinar.count({
          where: { webinarPlanId: webinarPlanId },
        });

        let deletedPlan = null;
        if (remainingInstancesCount === 0) {
          // 4. If no other instances use the plan, delete the plan
          // Note: Prisma cascade delete should handle related topics
          console.log(
            `Deleting webinar plan: ${webinarPlanId} as no other instances exist`,
          );
          deletedPlan = await tx.webinarPlan.delete({
            where: { id: webinarPlanId },
          });
        } else {
          console.log(
            `Webinar plan ${webinarPlanId} is still used by ${remainingInstancesCount} other instance(s), not deleting plan.`,
          );
        }

        return { deletedInstanceId: webinarId, deletedPlan };
      },
      {
        maxWait: 15000,
        timeout: 30000,
        isolationLevel: "Serializable",
      },
    );

    console.log("Webinar and potentially plan deleted successfully:", result);
    return NextResponse.json(
      {
        message:
          `Webinar ${result.deletedInstanceId} deleted successfully.` +
          (result.deletedPlan
            ? ` Plan ${result.deletedPlan.id} also deleted.`
            : " Plan was kept as it is used by other instances."),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting webinar:", error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid ID format", details: error.issues },
        { status: 400 },
      );
    }
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: "An error occurred during webinar deletion" },
      { status: 500 },
    );
  }
}

// Add dummy GET, POST, PATCH handlers if needed
// export async function GET(request: NextRequest, { params }: { params: Promise<{ webinarId: string }> }) {
//   return NextResponse.json({ message: "GET not implemented" }, { status: 405 });
// }
// export async function POST(request: NextRequest, { params }: { params: Promise<{ webinarId: string }> }) {
//   return NextResponse.json({ message: "POST not implemented" }, { status: 405 });
// }
// export async function PATCH(request: NextRequest, { params }: { params: Promise<{ webinarId: string }> }) {
//   return NextResponse.json({ message: "PATCH not implemented" }, { status: 405 });
// }
