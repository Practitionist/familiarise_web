"use client";

import { StreamVideo, StreamVideoClient } from "@stream-io/video-react-sdk";
import { useEffect, useState } from "react";
import { useUserData } from "@/hooks/useUserData";
import { tokenProvider } from "@/actions/stream.action";
const apiKey = process.env.NEXT_PUBLIC_STREAM_API_KEY;

const StreamVideoProvider = ({
  children,
  userId,
}: {
  children: React.ReactNode;
  userId: string;
}) => {
  const [videoClient, setVideoClient] = useState<
    StreamVideoClient | undefined
  >();
  const { userDetails, isLoading } = useUserData(userId);

  useEffect(() => {
    if (isLoading) {
      console.info("User data is loading");
      return;
    }

    if (!userDetails) {
      console.warn("User not found");
      return;
    }

    if (!apiKey) {
      console.error("Stream API key not configured");
      return;
    }

    const client = new StreamVideoClient({
      apiKey: apiKey,
      user: {
        id: userDetails.id,
        name: userDetails.name ?? userDetails.id,
        image: userDetails.image ?? undefined,
      },
      tokenProvider: () => tokenProvider(userId),
    });

    setVideoClient(client);
  }, [apiKey, isLoading, userDetails, userId]);

  if (!videoClient) {
    return (
      // Loading state
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    );
  }

  return <StreamVideo client={videoClient}>{children}</StreamVideo>;
};

export default StreamVideoProvider;
