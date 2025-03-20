"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import StreamChatProvider from "@/providers/StreamChatProvider";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { fetchConsulteeDetails } from "@/lib/user";

export default function MessagesTab() {
  const { consulteeId } = useParams();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUserId = async () => {
      try {
        const consulteeDetails = await fetchConsulteeDetails(consulteeId as string);
        setUserId(consulteeDetails.user.id);
      } catch (error) {
        console.error("Error fetching consultee details:", error);
      } finally {
        setLoading(false);
      }
    };

    if (consulteeId) {
      fetchUserId();
    }
  }, [consulteeId]);

  if (loading || !userId) {
    return (
      <div className="min-h-[calc(100vh-200px)]">
        <h2 className="text-3xl font-bold mb-6">Messages</h2>
        <div className="h-[calc(100vh-280px)] w-full flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-200px)]">
      <h2 className="text-3xl font-bold mb-6">Messages</h2>
      <div className="h-[calc(100vh-280px)] w-full bg-white rounded-lg shadow-lg overflow-hidden">
        <StreamChatProvider userId={userId}>
          <ChatLayout />
        </StreamChatProvider>
      </div>
    </div>
  );
}
