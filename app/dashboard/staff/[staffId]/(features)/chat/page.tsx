"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Search,
  Send,
  Users,
  Hash,
  Pin,
  MoreVertical,
  Smile,
  Paperclip,
  Bell,
  Loader2,
  RefreshCw,
  MessageSquare,
  Clock,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface SupportChannel {
  id: string;
  streamChannelId: string;
  status: "OPEN" | "ASSIGNED" | "RESOLVED" | "CLOSED";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  topic: string | null;
  createdAt: string;
  customer: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  };
  assignedStaff: {
    id: string;
    name: string | null;
  } | null;
}

interface QueueStats {
  total: number;
  unassigned: number;
  myChannels: number;
}

// Static team channels (these would typically come from Stream SDK)
const teamChannels = [
  { id: "1", name: "general", type: "channel", unread: 3, pinned: true },
  { id: "2", name: "support-team", type: "channel", unread: 0, pinned: true },
  { id: "3", name: "announcements", type: "channel", unread: 1, pinned: false },
  { id: "4", name: "escalations", type: "channel", unread: 5, pinned: false },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case "OPEN":
      return "bg-blue-100 text-blue-700";
    case "ASSIGNED":
      return "bg-yellow-100 text-yellow-700";
    case "RESOLVED":
      return "bg-green-100 text-green-700";
    case "CLOSED":
      return "bg-zinc-100 text-zinc-700";
    default:
      return "bg-zinc-100 text-zinc-700";
  }
};

const getPriorityColor = (priority: string) => {
  switch (priority) {
    case "URGENT":
      return "bg-red-100 text-red-700";
    case "HIGH":
      return "bg-orange-100 text-orange-700";
    case "MEDIUM":
      return "bg-yellow-100 text-yellow-700";
    case "LOW":
      return "bg-green-100 text-green-700";
    default:
      return "bg-zinc-100 text-zinc-700";
  }
};

const formatTime = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  return `${days}d`;
};

export default function TeamChatPage() {
  const [activeTab, setActiveTab] = useState("support");
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Support channels state
  const [supportChannels, setSupportChannels] = useState<SupportChannel[]>([]);
  const [queueChannels, setQueueChannels] = useState<SupportChannel[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [claiming, setClaiming] = useState<string | null>(null);

  const { toast } = useToast();

  // Fetch my support channels
  const fetchMyChannels = async () => {
    try {
      setLoadingChannels(true);
      const response = await fetch("/api/staff/chat/channels?assigned=true");
      if (!response.ok) throw new Error("Failed to fetch channels");
      const data = await response.json();
      setSupportChannels(data.channels || []);
    } catch (error) {
      console.error("Error fetching channels:", error);
      toast({
        title: "Error",
        description: "Failed to load support channels",
        variant: "destructive",
      });
    } finally {
      setLoadingChannels(false);
    }
  };

  // Fetch queue (unassigned channels)
  const fetchQueue = async () => {
    try {
      setLoadingQueue(true);
      const response = await fetch("/api/staff/chat/queue");
      if (!response.ok) throw new Error("Failed to fetch queue");
      const data = await response.json();
      setQueueChannels(data.channels || []);
    } catch (error) {
      console.error("Error fetching queue:", error);
      toast({
        title: "Error",
        description: "Failed to load support queue",
        variant: "destructive",
      });
    } finally {
      setLoadingQueue(false);
    }
  };

  // Claim a channel from the queue
  const claimChannel = async (channelId: string) => {
    try {
      setClaiming(channelId);
      const response = await fetch("/api/staff/chat/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId }),
      });

      if (!response.ok) throw new Error("Failed to claim channel");

      toast({
        title: "Channel Claimed",
        description: "You are now assigned to this support channel",
      });

      // Refresh both lists
      fetchMyChannels();
      fetchQueue();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to claim channel",
        variant: "destructive",
      });
    } finally {
      setClaiming(null);
    }
  };

  // Resolve a channel
  const resolveChannel = async (channelId: string) => {
    try {
      const response = await fetch(`/api/staff/chat/channels/${channelId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "RESOLVED" }),
      });

      if (!response.ok) throw new Error("Failed to resolve channel");

      toast({
        title: "Channel Resolved",
        description: "Support channel has been marked as resolved",
      });

      fetchMyChannels();
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to resolve channel",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    fetchMyChannels();
    fetchQueue();
  }, []);

  const selectedSupportChannel = supportChannels.find(
    (c) => c.id === selectedChannel
  );

  return (
    <div className="h-[calc(100vh-8rem)] flex gap-4">
      {/* Sidebar */}
      <Card className="w-80 flex flex-col">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Messages</CardTitle>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  fetchMyChannels();
                  fetchQueue();
                }}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Bell className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
            <Input
              placeholder="Search..."
              className="pl-9 h-9"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="flex-1 p-0 overflow-hidden">
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="h-full flex flex-col"
          >
            <TabsList className="mx-2 grid w-auto grid-cols-2">
              <TabsTrigger value="support" className="text-xs">
                Support ({supportChannels.length})
              </TabsTrigger>
              <TabsTrigger value="queue" className="text-xs">
                Queue ({queueChannels.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="support" className="flex-1 overflow-hidden m-0">
              <div className="h-full overflow-y-auto px-2 py-2">
                {loadingChannels ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                  </div>
                ) : supportChannels.length === 0 ? (
                  <p className="text-center text-zinc-500 py-8 text-sm">
                    No active support channels
                  </p>
                ) : (
                  <div className="space-y-1">
                    {supportChannels.map((channel) => (
                      <button
                        key={channel.id}
                        onClick={() => setSelectedChannel(channel.id)}
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                          selectedChannel === channel.id
                            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                            : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        )}
                      >
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={channel.customer.image || ""} />
                          <AvatarFallback className="text-xs">
                            {(channel.customer.name || channel.customer.email)
                              .split(" ")
                              .map((n) => n[0])
                              .join("")
                              .slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 text-left min-w-0">
                          <p className="font-medium truncate">
                            {channel.customer.name || channel.customer.email}
                          </p>
                          <p className="text-xs text-zinc-500 truncate">
                            {channel.topic || "General support"}
                          </p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <span className="text-xs text-zinc-400">
                            {formatTime(channel.createdAt)}
                          </span>
                          <Badge
                            className={cn(
                              "text-[10px] px-1.5 py-0",
                              getPriorityColor(channel.priority)
                            )}
                          >
                            {channel.priority}
                          </Badge>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Team Channels */}
                <div className="mt-4">
                  <p className="px-3 py-2 text-xs font-semibold text-zinc-500 uppercase">
                    Team Channels
                  </p>
                  {teamChannels.map((channel) => (
                    <button
                      key={channel.id}
                      onClick={() => setSelectedChannel(`team-${channel.id}`)}
                      className={cn(
                        "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                        selectedChannel === `team-${channel.id}`
                          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                          : "hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
                      )}
                    >
                      <Hash className="h-4 w-4" />
                      <span className="flex-1 text-left">{channel.name}</span>
                      {channel.pinned && (
                        <Pin className="h-3 w-3 text-zinc-400" />
                      )}
                      {channel.unread > 0 && (
                        <Badge
                          variant="destructive"
                          className="h-5 min-w-5 px-1.5"
                        >
                          {channel.unread}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="queue" className="flex-1 overflow-hidden m-0">
              <div className="h-full overflow-y-auto px-2 py-2">
                {loadingQueue ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
                  </div>
                ) : queueChannels.length === 0 ? (
                  <div className="text-center py-8">
                    <MessageSquare className="h-8 w-8 text-zinc-300 mx-auto mb-2" />
                    <p className="text-zinc-500 text-sm">
                      No channels in queue
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {queueChannels.map((channel) => (
                      <div
                        key={channel.id}
                        className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800"
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2">
                            <Avatar className="h-8 w-8">
                              <AvatarImage src={channel.customer.image || ""} />
                              <AvatarFallback className="text-xs">
                                {(
                                  channel.customer.name || channel.customer.email
                                )
                                  .split(" ")
                                  .map((n) => n[0])
                                  .join("")
                                  .slice(0, 2)}
                              </AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium text-sm">
                                {channel.customer.name || channel.customer.email}
                              </p>
                              <p className="text-xs text-zinc-500">
                                {channel.topic || "General support"}
                              </p>
                            </div>
                          </div>
                          <Badge
                            className={cn(
                              "text-[10px]",
                              getPriorityColor(channel.priority)
                            )}
                          >
                            {channel.priority}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between mt-2">
                          <span className="text-xs text-zinc-400 flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            Waiting {formatTime(channel.createdAt)}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => claimChannel(channel.id)}
                            disabled={claiming === channel.id}
                          >
                            {claiming === channel.id ? (
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            ) : null}
                            Claim
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Chat Area */}
      <Card className="flex-1 flex flex-col">
        {selectedChannel && selectedSupportChannel ? (
          <>
            {/* Chat Header */}
            <CardHeader className="border-b py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarImage
                      src={selectedSupportChannel.customer.image || ""}
                    />
                    <AvatarFallback>
                      {(
                        selectedSupportChannel.customer.name ||
                        selectedSupportChannel.customer.email
                      )
                        .split(" ")
                        .map((n) => n[0])
                        .join("")
                        .slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <h2 className="font-semibold">
                      {selectedSupportChannel.customer.name ||
                        selectedSupportChannel.customer.email}
                    </h2>
                    <p className="text-sm text-zinc-500">
                      {selectedSupportChannel.topic || "General support"}
                    </p>
                  </div>
                  <Badge className={getStatusColor(selectedSupportChannel.status)}>
                    {selectedSupportChannel.status}
                  </Badge>
                  <Badge
                    className={getPriorityColor(selectedSupportChannel.priority)}
                  >
                    {selectedSupportChannel.priority}
                  </Badge>
                </div>
                <div className="flex items-center gap-1">
                  {selectedSupportChannel.status === "ASSIGNED" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => resolveChannel(selectedSupportChannel.id)}
                    >
                      Mark Resolved
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>

            {/* Messages - Placeholder for Stream SDK integration */}
            <CardContent className="flex-1 p-0 overflow-hidden">
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <MessageSquare className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
                  <p className="text-zinc-500">
                    Chat messages will appear here
                  </p>
                  <p className="text-xs text-zinc-400 mt-1">
                    Stream SDK integration required for real-time messaging
                  </p>
                </div>
              </div>
            </CardContent>

            {/* Message Input */}
            <div className="p-4 border-t">
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" className="h-9 w-9">
                  <Paperclip className="h-4 w-4" />
                </Button>
                <div className="flex-1 relative">
                  <Input
                    placeholder="Type a message..."
                    className="pr-10"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && messageInput.trim()) {
                        // Send message logic here (Stream SDK)
                        setMessageInput("");
                      }
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                  >
                    <Smile className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  size="icon"
                  className="h-9 w-9"
                  disabled={!messageInput.trim()}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          // No channel selected
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <MessageSquare className="h-16 w-16 text-zinc-200 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-zinc-900">
                Select a conversation
              </h3>
              <p className="text-zinc-500 mt-1">
                Choose a support channel or team chat to start messaging
              </p>
              {queueChannels.length > 0 && (
                <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <div className="flex items-center gap-2 text-amber-700">
                    <AlertCircle className="h-4 w-4" />
                    <span className="text-sm font-medium">
                      {queueChannels.length} customer(s) waiting in queue
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
