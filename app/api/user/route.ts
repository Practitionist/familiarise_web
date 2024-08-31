import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const users = await prisma.user.findMany({
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
    return NextResponse.json(users, { status: 200 });
  } catch (error) {
    console.error("Error getting users:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const newUser = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        emailVerified: body.emailVerified,
        image: body.image,
        currentTimezone: body.currentTimezone || 'UTC',
        phone: body.phone,
        address: body.address,
        onboardingCompleted: body.onboardingCompleted || false,
        role: body.role || 'CONSULTEE',
      },
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

    return NextResponse.json(newUser, { status: 201 });
  } catch (error) {
    console.error("Error creating user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
