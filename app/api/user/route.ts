import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const users = await prisma.user.findMany({});
    return NextResponse.json({ data: users }, { status: 200 });
  } catch (error) {
    console.error("Error getting user:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
