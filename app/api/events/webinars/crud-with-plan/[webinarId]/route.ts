import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { webinarId: string } },
) {
  const webinarId = params.webinarId; // Extract ID from dynamic route

  // Validate webinarId (basic check)
  if (!webinarId) {
    return NextResponse.json(
      { error: "Webinar ID is required for deletion" },
      { status: 400 },
    );
  }

  console.log(`Attempting to delete webinar instance with ID: ${webinarId}`);

  try {
    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Find the webinar instance to get the plan ID
      const webinarInstance = await tx.webinar.findUnique({
        where: { id: webinarId },
        select: { webinarPlanId: true, webinarPlan: { select: { title: true } } },
      });

      if (!webinarInstance) {
        throw new Error(`Webinar instance with ID ${webinarId} not found.`);
      }

      const webinarPlanId = webinarInstance.webinarPlanId;
      const eventTitle = webinarInstance.webinarPlan.title;
      console.log(`Found webinar plan ID: ${webinarPlanId} for instance ${webinarId}`);

      // 2. Delete the webinar instance
      // Note: Prisma cascade delete might handle related appointment/slots automatically
      // If not, manual deletion of appointment and slots would be needed here first.
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
        console.log(`Deleting webinar plan: ${webinarPlanId} as no other instances exist`);
        deletedPlan = await tx.webinarPlan.delete({
          where: { id: webinarPlanId },
        });
      } else {
        console.log(`Webinar plan ${webinarPlanId} is still used by ${remainingInstancesCount} other instance(s), not deleting plan.`);
      }

      return { deletedInstanceId: webinarId, deletedPlan, eventTitle };
    }, {
      maxWait: 15000, // Allow 15 seconds for connection acquisition
      timeout: 30000, // Allow 30 seconds for the transaction itself
    });

    console.log("Webinar and potentially plan deleted successfully:", result);
    return NextResponse.json(
      {
        message: `Webinar "${result.eventTitle}" deleted successfully.` + 
                 (result.deletedPlan ? ' The associated plan was also deleted.' : ' The plan was kept as it is used by other instances.')
      },
      { status: 200 },
    );

  } catch (error) {
    console.error("Error deleting webinar:", error);
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: "An error occurred during webinar deletion" },
      { status: 500 },
    );
  }
}
