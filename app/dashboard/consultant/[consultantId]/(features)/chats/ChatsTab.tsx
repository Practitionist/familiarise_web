"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import StreamChatProvider from "@/providers/StreamChatProvider";
import { ChatLayout } from "@/components/chat/ChatLayout";
import { fetchConsultantDetails } from "@/lib/user";

export function ChatsTab() {
  const { consultantId } = useParams();
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUserId = async () => {
      try {
        const consultantDetails = await fetchConsultantDetails(consultantId as string);
        setUserId(consultantDetails.user.id);
      } catch (error) {
        console.error("Error fetching consultant details:", error);
      } finally {
        setLoading(false);
      }
    };

    if (consultantId) {
      fetchUserId();
    }
  }, [consultantId]);

  if (loading || !userId) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full bg-white rounded-lg shadow-lg overflow-hidden">
      <StreamChatProvider userId={userId}>
        <ChatLayout />
      </StreamChatProvider>
    </div>
  );
}
