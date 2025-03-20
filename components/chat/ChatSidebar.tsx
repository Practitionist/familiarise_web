"use client";

import { ChannelList } from "stream-chat-react";
import type { ChannelSort } from "stream-chat";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TeamChannelList } from "./TeamChannelList";
import { ChannelPreview } from "./ChannelPreview";
import { ChannelSearch } from "./ChannelSearch";

const filters = {
  team: { type: "team" },
  messaging: { type: "messaging" },
};

const options = { state: true, watch: true, presence: true, limit: 10 };
// Properly type the sort object for Stream Chat
const sort: ChannelSort = { last_message_at: -1 };

// Define the wrapper components outside the main component
// These components need to handle the props passed by the ChannelList component
const TeamChannelListWrapper = (props: Record<string, unknown>) => {
  return <TeamChannelList {...props} type="team" />;
};

// For the preview components, we need to ensure the channel prop is passed correctly
const TeamChannelPreviewWrapper = (props: any) => {
  if (!props.channel) return null;
  return <ChannelPreview channel={props.channel} type="team" setActiveChannel={props.setActiveChannel} />;
};

const MessagingChannelListWrapper = (props: Record<string, unknown>) => {
  return <TeamChannelList {...props} type="messaging" />;
};

const MessagingChannelPreviewWrapper = (props: any) => {
  if (!props.channel) return null;
  return <ChannelPreview channel={props.channel} type="messaging" setActiveChannel={props.setActiveChannel} />;
};

export const ChatSidebar = () => {
  return (
    <div className="w-64 bg-blue-600 text-white flex flex-col h-full">
      <div className="p-4 border-b border-blue-700">
        <h1 className="text-xl font-bold">Familiarise</h1>
      </div>
      
      <div className="p-4">
        <ChannelSearch />
      </div>
      
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2 flex justify-between items-center">
          <h2 className="font-semibold">Channels</h2>
          <Button variant="ghost" size="sm" className="p-1 text-white hover:bg-blue-700">
            <PlusIcon className="h-4 w-4" />
          </Button>
        </div>
        
        <ChannelList
          filters={filters.team}
          options={options}
          sort={sort}
          List={TeamChannelListWrapper}
          Preview={TeamChannelPreviewWrapper}
        />
        
        <div className="px-4 py-2 flex justify-between items-center mt-4">
          <h2 className="font-semibold">Direct Messages</h2>
          <Button variant="ghost" size="sm" className="p-1 text-white hover:bg-blue-700">
            <PlusIcon className="h-4 w-4" />
          </Button>
        </div>
        
        <ChannelList
          filters={filters.messaging}
          options={options}
          sort={sort}
          setActiveChannelOnMount={false}
          List={MessagingChannelListWrapper}
          Preview={MessagingChannelPreviewWrapper}
        />
      </div>
    </div>
  );
};
