"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { Channel } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { ChannelSearch } from "./ChannelSearch";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { CreateDirectMessageDialog } from "./CreateDirectMessageDialog";
import { InitializeUserChannelsButton } from "./InitializeUserChannelsButton";

// Empty state component for when there are no channels
const EmptyChannelState = () => (
  <div className="flex flex-col items-center justify-center p-8 text-center text-blue-200">
    <MessageSquareIcon className="w-16 h-16 mb-4 opacity-50" />
    <p className="text-sm">You have no channels currently</p>
  </div>
);

// Custom channel item component for the sidebar
const ChannelItem = ({ channel, isActive, onClick }: { channel: Channel; isActive: boolean; onClick: () => void }) => {
  const { client } = useChatContext();
  const isTeamChannel = channel.type === 'team';
  
  // For direct messages, get the other user's details
  let displayName = channel.data?.name || channel.id || '';
  let displayImage: string | undefined = undefined;
  
  if (!isTeamChannel && client) {
    // Find the other member in the channel
    const otherMember = Object.values(channel.state.members || {}).find(
      (member) => member.user?.id !== client.userID
    )?.user;
    
    if (otherMember) {
      displayName = otherMember.name || otherMember.id || 'Unknown User';
      displayImage = otherMember.image as string || undefined;
    }
  }
  
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-2 hover:bg-blue-700 transition-colors ${isActive ? 'bg-blue-700' : ''}`}
    >
      {isTeamChannel ? (
        <div className="flex items-center">
          <span className="text-blue-200 mr-2">#</span>
          <span className="font-medium">{displayName}</span>
        </div>
      ) : (
        <div className="flex items-center">
          <Avatar className="w-6 h-6 mr-2">
            <AvatarImage src={displayImage || "/placeholder-user.jpg"} />
            <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
          </Avatar>
          <span className="font-medium">{displayName}</span>
        </div>
      )}
    </button>
  );
};

export const ChatSidebar = () => {
  const { client, setActiveChannel } = useChatContext();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [directMessages, setDirectMessages] = useState<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  
  // Function to trigger a refresh of the channel list
  const refreshChannels = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  useEffect(() => {
    const fetchChannels = async () => {
      if (!client) return;
      
      try {
        console.log("Fetching channels for user:", client.userID);
        
        // Fetch team channels (webinars and classes)
        // Use more specific filters to find channels related to webinars and classes
        const teamResponse = await client.queryChannels(
          { 
            type: 'team',
            members: { $in: [client.userID || ""] }
          },
          { last_message_at: -1 },
          { watch: true, state: true, limit: 30 }
        );
        
        console.log("Team channels found:", teamResponse.length);
        console.log("Team channels:", teamResponse.map(c => ({ 
          id: c.id, 
          name: c.data?.name,
          members: Object.keys(c.state.members || {})
        })));
        
        // Fetch direct message channels
        const dmResponse = await client.queryChannels(
          { 
            type: 'messaging',
            members: { $in: [client.userID || ""] }
          },
          { last_message_at: -1 },
          { watch: true, state: true, limit: 30 }
        );
        
        console.log("DM channels found:", dmResponse.length);
        console.log("DM channels:", dmResponse.map(c => ({ 
          id: c.id, 
          members: Object.keys(c.state.members || {})
        })));
        
        setChannels(teamResponse);
        setDirectMessages(dmResponse);
      } catch (error) {
        console.error('Error fetching channels:', error);
      } finally {
        setLoading(false);
      }
    };
    
    if (client) {
      fetchChannels();
    }
  }, [client, refreshTrigger]);

  const handleChannelSelect = (channel: Channel) => {
    setActiveChannelId(channel.id || null);
    setActiveChannel(channel);
  };

  return (
    <div className="w-64 bg-blue-600 text-white flex flex-col h-full">
      <div className="p-4 border-b border-blue-700">
        <h1 className="text-xl font-bold">Worksly</h1>
      </div>
      
      <div className="p-4">
        <ChannelSearch />
      </div>
      
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2 flex justify-between items-center">
          <h2 className="font-semibold">Channels</h2>
          <CreateChannelDialog onChannelCreated={refreshChannels} />
        </div>
        
        {loading ? (
          <div className="p-4">
            <div className="animate-pulse space-y-2">
              <div className="h-4 bg-blue-700 rounded w-3/4"></div>
              <div className="h-4 bg-blue-700 rounded"></div>
              <div className="h-4 bg-blue-700 rounded w-5/6"></div>
            </div>
          </div>
        ) : channels.length > 0 ? (
          <div>
            {channels.map((channel) => (
              <ChannelItem 
                key={channel.id} 
                channel={channel} 
                isActive={channel.id === activeChannelId}
                onClick={() => handleChannelSelect(channel)}
              />
            ))}
          </div>
        ) : (
          <EmptyChannelState />
        )}
        
        <div className="px-4 py-2 flex justify-between items-center mt-4">
          <h2 className="font-semibold">Direct Messages</h2>
          <CreateDirectMessageDialog onChannelCreated={refreshChannels} />
        </div>
        
        {loading ? (
          <div className="p-4">
            <div className="animate-pulse space-y-2">
              <div className="h-4 bg-blue-700 rounded w-3/4"></div>
              <div className="h-4 bg-blue-700 rounded"></div>
              <div className="h-4 bg-blue-700 rounded w-5/6"></div>
            </div>
          </div>
        ) : directMessages.length > 0 ? (
          <div>
            {directMessages.map((channel) => (
              <ChannelItem 
                key={channel.id} 
                channel={channel} 
                isActive={channel.id === activeChannelId}
                onClick={() => handleChannelSelect(channel)}
              />
            ))}
          </div>
        ) : (
          <EmptyChannelState />
        )}
      </div>
      
      {/* Add a footer with the initialize channels button */}
      <div className="p-4 border-t border-blue-700">
        {client && client.userID && (
          <InitializeUserChannelsButton 
            userId={client.userID} 
            variant="default" 
            size="sm"
            className="w-full flex items-center justify-center gap-2 text-sm"
            onSuccess={refreshChannels}
          >
            <RefreshCwIcon className="h-4 w-4" />
            Sync Event Channels
          </InitializeUserChannelsButton>
        )}
      </div>
    </div>
  );
};
