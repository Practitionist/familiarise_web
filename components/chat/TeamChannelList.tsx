"use client";

import type { ReactNode } from "react";

// Define our own props type since ChannelListMessengerProps changed in v13
interface TeamChannelListProps {
  children?: ReactNode;
  error?: Error | boolean | null;
  loading?: boolean;
  type: "team" | "messaging";
}

export const TeamChannelList = ({
  children,
  error = false,
  loading,
  type: _type,
}: TeamChannelListProps) => {
  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-sm text-red-500">
          Connection error, please try again later.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-4 text-center">
        <div className="animate-pulse flex space-x-4">
          <div className="flex-1 space-y-2 py-1">
            <div className="h-4 bg-blue-700 rounded w-3/4"></div>
            <div className="h-4 bg-blue-700 rounded"></div>
            <div className="h-4 bg-blue-700 rounded w-5/6"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="team-channel-list">
      <div className="px-4">{children}</div>
    </div>
  );
};
