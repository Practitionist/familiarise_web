import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
// Remove Zod import if no longer needed, or keep if used elsewhere
// import { z } from "zod";

// Remove UUID schema
// const uuidSchema = z.string().uuid();

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  try {
    // Add session check if needed
    // const session = await getServerSession(authOptions);
    // if (!session) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const awaitedParams = await params;
    const { classId } = awaitedParams;

    // Replace UUID validation with simple string check
    if (!classId || typeof classId !== "string") {
      return NextResponse.json(
        { error: "Invalid or missing Class ID" }, // Updated error message
        { status: 400 },
      );
    }

    console.log(`Attempting to delete class instance with ID: ${classId}`);

    // Start transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // 1. Find the class instance, get plan ID AND plan title
        const classInstance = await tx.class.findUnique({
          where: { id: classId },
          select: {
            classPlanId: true,
            // Include the related plan to get its title
            classPlan: { select: { title: true } },
          },
        });

        if (!classInstance) {
          throw new Error(`Class instance with ID ${classId} not found.`);
        }

        const classPlanId = classInstance.classPlanId;
        const eventTitle = classInstance.classPlan.title; // Store the title
        console.log(
          `Found class plan ID: ${classPlanId} (Title: "${eventTitle}") for instance ${classId}`,
        );

        // 2. Delete the class instance
        console.log(`Deleting class instance: ${classId}`);
        await tx.class.delete({ where: { id: classId } });

        // 3. Check if other instances use the same plan
        const remainingInstancesCount = await tx.class.count({
          where: { classPlanId: classPlanId },
        });

        let planWasDeleted = false; // Flag to know if plan deletion happened
        if (remainingInstancesCount === 0) {
          // 4. Delete the plan if needed
          console.log(
            `Deleting class plan: ${classPlanId} as no other instances exist`,
          );
          await tx.classPlan.delete({ where: { id: classPlanId } });
          planWasDeleted = true;
        } else {
          console.log(
            `Class plan ${classPlanId} is still used by ${remainingInstancesCount} other instance(s), not deleting plan.`,
          );
        }

        // Return title and whether plan was deleted
        return { eventTitle, planWasDeleted };
      },
      {
        maxWait: 15000, // Allow 15 seconds for connection acquisition
        timeout: 30000, // Allow 30 seconds for the transaction itself
        isolationLevel: "Serializable", // Keep high isolation if appropriate
      },
    );

    console.log("Class and potentially plan deleted successfully:", result);
    // Use the fetched title in the response message
    return NextResponse.json(
      {
        message:
          `Class "${result.eventTitle}" deleted successfully.` + // Use title
          (result.planWasDeleted
            ? ` The associated plan was also deleted.`
            : " The associated plan was kept as it is used by other instances."),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting class:", error);
    // Remove specific ZodError check if Zod is fully removed
    // if (error instanceof z.ZodError) { ... }
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
