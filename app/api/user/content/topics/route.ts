import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const query = searchParams.get("query") ?? "";

    const topics = await prisma.topic.findMany({
      where: query
        ? {
            name: {
              contains: query,
              mode: "insensitive",
            },
          }
        : undefined,
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
    const { names } = body;
    console.log("Received topic creation request:", { names });

    // Validate request
    if (!Array.isArray(names) || names.length === 0) {
      return NextResponse.json(
        { error: "Topics array is required" },
        { status: 400 },
      );
    }

    // Process each name to ensure it's a string and not empty
    const validNames = names.filter(
      (name): name is string =>
        typeof name === "string" && name.trim().length > 0,
    );

    if (validNames.length === 0) {
      return NextResponse.json(
        { error: "No valid topic names provided" },
        { status: 400 },
      );
    }

    // Find existing topics
    const existingTopics = await prisma.topic.findMany({
      where: {
        name: {
          in: validNames,
          mode: "insensitive",
        },
      },
    });

    // Filter out names that already exist
    const existingNames = new Set(
      existingTopics.map((t) => t.name.toLowerCase()),
    );
    const newNames = validNames.filter(
      (name) => !existingNames.has(name.toLowerCase()),
    );

    // Create new topics in a single transaction
    const newTopics =
      newNames.length > 0
        ? await prisma.topic.createMany({
            data: newNames.map((name) => ({ name })),
            skipDuplicates: true,
          })
        : { count: 0 };

    // Fetch all topics (both existing and newly created)
    const allTopics = await prisma.topic.findMany({
      where: {
        name: {
          in: validNames,
          mode: "insensitive",
        },
      },
    });

    return NextResponse.json(
      {
        data: allTopics,
        created: newTopics.count,
        existing: existingTopics.length,
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("Error creating topics:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the topics" },
      { status: 500 },
    );
  }
}

// Add DELETE endpoint for rolling back newly created topics
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "Topic IDs array is required" },
        { status: 400 },
      );
    }

    console.log("Request to delete topics with IDs:", ids);

    // Find topics to be deleted so we can log what was removed
    const topicsToDelete = await prisma.topic.findMany({
      where: {
        id: {
          in: ids,
        },
      },
    });

    // Only delete newly created topics
    const deleteResult = await prisma.topic.deleteMany({
      where: {
        id: {
          in: ids,
        },
        // Optional: Add a timestamp check to ensure we only delete recently created topics
        // This adds an extra safety measure
        createdAt: {
          gte: new Date(Date.now() - 1000 * 60 * 60), // Topics created in the last hour
        },
      },
    });

    // Check if any topics were actually deleted (i.e., they met the criteria including createdAt)
    if (deleteResult.count === 0 && topicsToDelete.length > 0) {
      // If topics were found but not deleted, it means they weren't recent enough
      return NextResponse.json(
        {
          error:
            "No recently created topics found with the provided IDs. Rollback might not be necessary or topics are older than expected.",
          deleted: 0,
          topicsAttempted: topicsToDelete.map((t) => t.name),
        },
        { status: 404 }, // 404 Not Found or 400 Bad Request could be appropriate
      );
    }

    return NextResponse.json(
      {
        deleted: deleteResult.count,
        topicsDeleted: topicsToDelete.map((t) => t.name),
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting topics:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting topics" },
      { status: 500 },
    );
  }
}
