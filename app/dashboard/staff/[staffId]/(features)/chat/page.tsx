"use client";

import { useState } from "react";
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
  Circle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Mock data
const channels = [
  { id: "1", name: "general", type: "channel", unread: 3, pinned: true },
  { id: "2", name: "support-team", type: "channel", unread: 0, pinned: true },
  { id: "3", name: "announcements", type: "channel", unread: 1, pinned: false },
  { id: "4", name: "escalations", type: "channel", unread: 5, pinned: false },
];

const directMessages = [
  {
    id: "dm1",
    user: { name: "Admin User", avatar: "", status: "online" },
    lastMessage: "Can you check ticket #TKT-156?",
    time: "2m",
    unread: 1,
  },
  {
    id: "dm2",
    user: { name: "Staff Member 2", avatar: "", status: "online" },
    lastMessage: "Done with the refund",
    time: "15m",
    unread: 0,
  },
  {
    id: "dm3",
    user: { name: "Staff Member 3", avatar: "", status: "away" },
    lastMessage: "I'll handle it",
    time: "1h",
    unread: 0,
  },
  {
    id: "dm4",
    user: { name: "Staff Member 4", avatar: "", status: "offline" },
    lastMessage: "See you tomorrow!",
    time: "3h",
    unread: 0,
  },
];

const messages = [
  {
    id: "1",
    user: { name: "Admin User", avatar: "" },
    content:
      "Good morning team! Just a reminder - we have a platform maintenance scheduled for tonight at 2 AM IST.",
    time: "9:00 AM",
    isOwn: false,
  },
  {
    id: "2",
    user: { name: "Staff Member 2", avatar: "" },
    content: "Thanks for the heads up! I'll update the status page.",
    time: "9:05 AM",
    isOwn: false,
  },
  {
    id: "3",
    user: { name: "You", avatar: "" },
    content: "Got it. Should we also send an email notification to users?",
    time: "9:08 AM",
    isOwn: true,
  },
  {
    id: "4",
    user: { name: "Admin User", avatar: "" },
    content:
      "Yes, please draft an email and share it here for review before sending.",
    time: "9:10 AM",
    isOwn: false,
  },
  {
    id: "5",
    user: { name: "Staff Member 3", avatar: "" },
    content: "I can help with that. Give me 10 minutes.",
    time: "9:12 AM",
    isOwn: false,
  },
  {
    id: "6",
    user: { name: "You", avatar: "" },
    content: "Perfect, thanks!",
    time: "9:13 AM",
    isOwn: true,
  },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case "online":
      return "bg-green-500";
    case "away":
      return "bg-yellow-500";
    case "offline":
      return "bg-zinc-400";
    default:
      return "bg-zinc-400";
  }
};

export default function TeamChatPage() {
  const [selectedChannel, setSelectedChannel] = useState("1");
  const [messageInput, setMessageInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const selectedChannelData = channels.find((c) => c.id === selectedChannel);

  return (
    <div className="h-[calc(100vh-8rem)] flex gap-4">
      {/* Sidebar */}
      <Card className="w-72 flex flex-col">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Messages</CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Bell className="h-4 w-4" />
            </Button>
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
          <div className="h-full overflow-y-auto">
            {/* Channels */}
            <div className="px-2 pb-2">
              <p className="px-3 py-2 text-xs font-semibold text-zinc-500 uppercase">
                Channels
              </p>
              {channels.map((channel) => (
                <button
                  key={channel.id}
                  onClick={() => setSelectedChannel(channel.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                    selectedChannel === channel.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400",
                  )}
                >
                  <Hash className="h-4 w-4" />
                  <span className="flex-1 text-left">{channel.name}</span>
                  {channel.pinned && <Pin className="h-3 w-3 text-zinc-400" />}
                  {channel.unread > 0 && (
                    <Badge variant="destructive" className="h-5 min-w-5 px-1.5">
                      {channel.unread}
                    </Badge>
                  )}
                </button>
              ))}
            </div>

            {/* Direct Messages */}
            <div className="px-2 pb-2">
              <p className="px-3 py-2 text-xs font-semibold text-zinc-500 uppercase">
                Direct Messages
              </p>
              {directMessages.map((dm) => (
                <button
                  key={dm.id}
                  onClick={() => setSelectedChannel(dm.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                    selectedChannel === dm.id
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-800",
                  )}
                >
                  <div className="relative">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={dm.user.avatar} />
                      <AvatarFallback className="text-xs">
                        {dm.user.name
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </AvatarFallback>
                    </Avatar>
                    <div
                      className={cn(
                        "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-zinc-900",
                        getStatusColor(dm.user.status),
                      )}
                    />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <p className="font-medium truncate">{dm.user.name}</p>
                    <p className="text-xs text-zinc-500 truncate">
                      {dm.lastMessage}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-xs text-zinc-400">{dm.time}</span>
                    {dm.unread > 0 && (
                      <Badge
                        variant="destructive"
                        className="h-5 min-w-5 px-1.5"
                      >
                        {dm.unread}
                      </Badge>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Chat Area */}
      <Card className="flex-1 flex flex-col">
        {/* Chat Header */}
        <CardHeader className="border-b py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Hash className="h-5 w-5 text-zinc-400" />
              <h2 className="font-semibold">
                {selectedChannelData?.name || "general"}
              </h2>
              <Badge variant="secondary" className="text-xs">
                <Users className="h-3 w-3 mr-1" />
                12 members
              </Badge>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Pin className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Search className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>

        {/* Messages */}
        <CardContent className="flex-1 p-0 overflow-hidden">
          <div className="h-full overflow-y-auto p-4">
            <div className="space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    "flex gap-3",
                    message.isOwn && "flex-row-reverse",
                  )}
                >
                  <Avatar className="h-8 w-8 flex-shrink-0">
                    <AvatarImage src={message.user.avatar} />
                    <AvatarFallback className="text-xs">
                      {message.user.name
                        .split(" ")
                        .map((n) => n[0])
                        .join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div
                    className={cn("max-w-[70%]", message.isOwn && "text-right")}
                  >
                    <div
                      className={cn(
                        "flex items-baseline gap-2",
                        message.isOwn && "flex-row-reverse",
                      )}
                    >
                      <span className="text-sm font-medium">
                        {message.user.name}
                      </span>
                      <span className="text-xs text-zinc-400">
                        {message.time}
                      </span>
                    </div>
                    <div
                      className={cn(
                        "mt-1 px-4 py-2 rounded-2xl text-sm",
                        message.isOwn
                          ? "bg-blue-600 text-white rounded-br-md"
                          : "bg-zinc-100 dark:bg-zinc-800 rounded-bl-md",
                      )}
                    >
                      {message.content}
                    </div>
                  </div>
                </div>
              ))}
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
                    // Send message logic here
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
      </Card>
    </div>
  );
}
