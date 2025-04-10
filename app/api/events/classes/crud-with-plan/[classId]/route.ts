import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Basic validation for UUID
const uuidSchema = z.string().uuid();

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> }, // Use Promise for params
) {
  try {
    // Add session check if needed
    // const session = await getServerSession(authOptions);
    // if (!session) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const awaitedParams = await params; // Await the promise
    const { classId } = awaitedParams;

    // Validate the extracted ID
    const validationResult = uuidSchema.safeParse(classId);
    if (!validationResult.success) {
      return NextResponse.json(
        { error: "Invalid Class ID format" },
        { status: 400 },
      );
    }

    console.log(`Attempting to delete class instance with ID: ${classId}`);

    // Start transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // 1. Find the class instance to get the plan ID
        const classInstance = await tx.class.findUnique({
          where: { id: classId },
          select: { classPlanId: true }, // Only need the plan ID
        });

        if (!classInstance) {
          throw new Error(`Class instance with ID ${classId} not found.`);
        }

        const classPlanId = classInstance.classPlanId;
        console.log(
          `Found class plan ID: ${classPlanId} for instance ${classId}`,
        );

        // 2. Delete the class instance
        // Note: Prisma cascade delete should handle related appointments/slots/meetingRoom/waitlist
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
          // Note: Prisma cascade delete should handle related classContents/topics
          console.log(
            `Deleting class plan: ${classPlanId} as no other instances exist`,
          );
          deletedPlan = await tx.classPlan.delete({
            where: { id: classPlanId },
          });
        } else {
          console.log(
            `Class plan ${classPlanId} is still used by ${remainingInstancesCount} other instance(s), not deleting plan.`,
          );
        }

        return { deletedInstanceId: classId, deletedPlan };
      },
      {
        maxWait: 15000, // Allow 15 seconds for connection acquisition
        timeout: 30000, // Allow 30 seconds for the transaction itself
        isolationLevel: "Serializable", // Keep high isolation if appropriate
      },
    );

    console.log("Class and potentially plan deleted successfully:", result);
    return NextResponse.json(
      {
        message:
          `Class ${result.deletedInstanceId} deleted successfully.` +
          (result.deletedPlan
            ? ` Plan ${result.deletedPlan.id} also deleted.`
            : " Plan was kept as it is used by other instances."),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting class:", error);
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
      { error: "An error occurred during class deletion" },
      { status: 500 },
    );
  }
}

// Add dummy GET, POST, PATCH handlers if needed to satisfy Next.js file conventions
// export async function GET(request: NextRequest, { params }: { params: Promise<{ classId: string }> }) {
//   return NextResponse.json({ message: "GET not implemented" }, { status: 405 });
// }
// export async function POST(request: NextRequest, { params }: { params: Promise<{ classId: string }> }) {
//   return NextResponse.json({ message: "POST not implemented" }, { status: 405 });
// }
// export async function PATCH(request: NextRequest, { params }: { params: Promise<{ classId: string }> }) {
//   return NextResponse.json({ message: "PATCH not implemented" }, { status: 405 });
// }
