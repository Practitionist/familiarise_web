import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { classId: string } },
) {
  const classId = params.classId; // Extract ID from dynamic route

  // Validate classId
  if (!classId) {
    return NextResponse.json(
      { error: "Class ID is required for deletion" },
      { status: 400 },
    );
  }

  console.log(`Attempting to delete class instance with ID: ${classId}`);

  try {
    // Start transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Find the class instance to get the plan ID
      const classInstance = await tx.class.findUnique({
        where: { id: classId },
        select: { classPlanId: true, classPlan: { select: { title: true } } },
      });

      if (!classInstance) {
        throw new Error(`Class instance with ID ${classId} not found.`);
      }

      const classPlanId = classInstance.classPlanId;
      const eventTitle = classInstance.classPlan.title;
      console.log(`Found class plan ID: ${classPlanId} for instance ${classId}`);

      // 2. Delete the class instance
      // Note: Prisma cascade delete *should* handle related appointments, slots, contents, etc.
      // Verify this behaviour. If not, manual deletion of related entities needed here.
      console.log(`Deleting class instance: ${classId}`);
      await tx.class.delete({
        where: { id: classId },
      });

      // 3. Check if other class instances use the same plan
      const remainingInstancesCount = await tx.class.count({
        where: { classPlanId: classPlanId },
      });

      let deletedPlan = null;
      if (remainingInstancesCount === 0) {
        // 4. If no other instances use the plan, delete the plan
        // Also check cascade deletes ClassContent implicitly.
        console.log(`Deleting class plan: ${classPlanId} as no other instances exist`);
        deletedPlan = await tx.classPlan.delete({
          where: { id: classPlanId },
        });
      } else {
        console.log(`Class plan ${classPlanId} is still used by ${remainingInstancesCount} other instance(s), not deleting plan.`);
      }

      return { deletedInstanceId: classId, deletedPlan, eventTitle };
    }, {
      maxWait: 15000, // Allow 15 seconds for connection acquisition
      timeout: 30000, // Allow 30 seconds for the transaction itself
    });

    console.log("Class and potentially plan deleted successfully:", result);
    return NextResponse.json(
      {
        message: `Class "${result.eventTitle}" deleted successfully.` + 
                 (result.deletedPlan ? ' The associated plan was also deleted.' : ' The plan was kept as it is used by other instances.')
      },
      { status: 200 },
    );

  } catch (error) {
    console.error("Error deleting class:", error);
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: "An error occurred during class deletion" },
      { status: 500 },
    );
  }
}

