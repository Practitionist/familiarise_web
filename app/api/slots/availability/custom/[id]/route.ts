import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const customSlot = await prisma.slotOfAvailabiltyCustom.findUnique({
      where: { id: params.id },
      include: {
        consultantProfile: true,
        slotOfAppointmentRequest: true,
      },
    });

    if (!customSlot) {
      return NextResponse.json(
        { error: "Slot not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(customSlot, { status: 200 });

  } catch (error) {
    console.error("Error fetching slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

// export async function POST(req: NextRequest, res: NextResponse) {
//   try {
//     const body = await req.json();

//     const newSlot = await prisma.slotOfAvailabiltyCustom.create({
//       data: {
//         consultantProfile: { connect: { id: body.consultantProfileId } },
//         slotStartTimeInUTC: body.slotStartTimeInUTC,
//         slotEndTimeInUTC: body.slotEndTimeInUTC,
//         // Additional fields can be added here if needed
//       },
//     });

//     return NextResponse.json(newSlot, { status: 201 });
//   } catch (error) {
//     console.error("Error creating slot:", error);
//     return NextResponse.json(
//       { error: "Something went wrong" },
//       { status: 500 }
//     );
//   }
// }

export async function PUT(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const updatedSlot = await prisma.slotOfAvailabiltyCustom.update({
      where: { id: params.id },
      data: {
        slotStartTimeInUTC: body.slotStartTimeInUTC,
        slotEndTimeInUTC: body.slotEndTimeInUTC,
        consultantProfile: body.consultantProfileId ? { connect: { id: body.consultantProfileId } } : undefined,
      },
      include: {
        consultantProfile: true,
        slotOfAppointmentRequest: true,
      },
    });

    return NextResponse.json(updatedSlot, { status: 200 });
  } catch (error) {
    console.error("Error updating slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json();

    const updatedSlot = await prisma.slotOfAvailabiltyCustom.update({
      where: { id: params.id },
      data: {
        slotStartTimeInUTC: body.slotStartTimeInUTC,
        slotEndTimeInUTC: body.slotEndTimeInUTC,
        consultantProfile: body.consultantProfileId ? { connect: { id: body.consultantProfileId } } : undefined,
      },
      include: {
        consultantProfile: true,
        slotOfAppointmentRequest: true,
      },
    });

    return NextResponse.json(updatedSlot, { status: 200 });
  } catch (error) {
    console.error("Error partially updating slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const deletedSlot = await prisma.slotOfAvailabiltyCustom.delete({
      where: { id: params.id },
      include: {
        consultantProfile: true,
        slotOfAppointmentRequest: true,
      },
    });

    return NextResponse.json(
      { message: "Slot deleted successfully", data: deletedSlot },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error deleting slot:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
