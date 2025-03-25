import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("query") || "";
    
    const topics = await prisma.topic.findMany({
      where: query ? {
        name: {
          contains: query,
          mode: 'insensitive',
        }
      } : undefined,
    });

    return NextResponse.json(
      {
        data: topics,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching topics:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching topics" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name } = body;

    // Validate request
    if (!name) {
      return NextResponse.json(
        { error: "Topic name is required" },
        { status: 400 },
      );
    }

    // Check if topic already exists
    const existingTopic = await prisma.topic.findFirst({
      where: {
        name,
      },
    });

    // If topic exists, return it
    if (existingTopic) {
      return NextResponse.json(
        { data: existingTopic },
        { status: 200 },
      );
    }

    // Create new topic
    const topic = await prisma.topic.create({
      data: {
        name,
      },
    });

    return NextResponse.json(
      { data: topic },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error creating topic:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the topic" },
      { status: 500 },
    );
  }
}