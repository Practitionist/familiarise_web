import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: params.id },
      include: {
        consultantProfile: true,
        consulteeProfile: true,
        accounts: true,
        sessions: true,
        attachments: true,
        comments: true,
        commentLikes: true,
        images: true,
        imageLikes: true,
        posts: true,
        postLikes: true,
        postsAttachments: true,
        usersImages: true,
        cookiePreferences: true,
        notificationPreferences: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ data: user }, { status: 200 });
  } catch (error) {
    console.error("Error getting user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const user = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        emailVerified: body.emailVerified,
        image: body.image,
        phone: body.phone,
        address: body.address,
        onboardingCompleted: body.onboardingCompleted,
        role: body.role,
      },
    });

    return NextResponse.json({ data: user }, { status: 201 });
  } catch (error) {
    console.error("Error creating user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    const body = await req.json();

    const updatedUser = await prisma.user.update({
      where: { id: params.id },
      data: {
        name: body.name,
        email: body.email,
        emailVerified: body.emailVerified,
        image: body.image,
        phone: body.phone,
        address: body.address,
        onboardingCompleted: body.onboardingCompleted,
        role: body.role,
      },
    });

    return NextResponse.json({ data: updatedUser }, { status: 200 });
  } catch (error) {
    console.error("Error updating user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  try {
    await prisma.user.delete({ where: { id: params.id } });

    return NextResponse.json({ message: "User deleted" }, { status: 200 });
  } catch (error) {
    console.error("Error deleting user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
