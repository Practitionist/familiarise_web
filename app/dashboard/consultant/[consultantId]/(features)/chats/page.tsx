import { fetchConsultantDetails } from "@/lib/user";
import { ChatsTab } from "./ChatsTab";

// This is an async Server Component
export default async function ChatsPage({
  params,
}: {
  params: Promise<{ consultantId: string }>;
}) {
  const { consultantId } = await params;

  let userId: string | null = null;
  let userRole: string | null = null;
  let error: string | null = null;

  try {
    const consultantDetails = await fetchConsultantDetails(consultantId);
    if (consultantDetails?.user) {
      userId = consultantDetails.user.id;
      userRole = consultantDetails.user.role;
    } else {
      // If user is null but no error was thrown by fetchConsultantDetails,
      // it might mean the consultantId is valid but has no associated user record.
      throw new Error("User details not found for the given consultant ID.");
    }
  } catch (err) {
    console.error("Error fetching consultant details for chat page:", err);
    error =
      err instanceof Error ? err.message : "Failed to load user data for chat.";
    // In a real app, you might want to log this more robustly or have specific error codes
  }

  // Handle error case - ideally show an error message via an error boundary
  // or a more user-friendly error component within the main layout.
  if (error || !userId) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <div
          className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative"
          role="alert"
        >
          <strong className="font-bold">Error: </strong>
          <span className="block sm:inline">
            {error || "Could not load required user information for chat."}
          </span>
        </div>
      </div>
    );
  }

  // Pass the fetched data to the Client Component
  return <ChatsTab userId={userId} userRole={userRole} />;
}
