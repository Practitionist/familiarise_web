import { searchUsers, upsertUsersToStream } from "@/actions/user.action";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const searchTerm = url.searchParams.get("term");
    
    if (!searchTerm) {
      return NextResponse.json(
        { success: false, error: "Search term is required" },
        { status: 400 }
      );
    }
    
    console.log(`Searching for users with term: ${searchTerm}`);
    
    // Search for users using our server action
    const users = await searchUsers(searchTerm);
    
    console.log(`Found ${users.length} users`);
    
    // If users are found, upsert them to Stream Chat
    if (users.length > 0) {
      try {
        // Get user IDs
        const userIds = users.map(user => user.id);
        
        // Upsert users to Stream Chat
        await upsertUsersToStream(userIds);
        
        console.log(`Upserted ${users.length} users to Stream Chat`);
      } catch (upsertError) {
        console.error("Error upserting users to Stream Chat:", upsertError);
        // Continue even if upserting fails
      }
    }
    
    return NextResponse.json({
      success: true,
      users
    });
  } catch (error) {
    console.error("Error searching users:", error);
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
