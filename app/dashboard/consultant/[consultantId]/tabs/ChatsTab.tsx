import React, { useState } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MoveHorizontalIcon,
  SendIcon,
  PhoneIcon,
  VideoIcon,
  SearchIcon,
  ArrowLeftIcon,
} from "lucide-react";

export function ChatsTab() {
  const [selectedChat, setSelectedChat] = useState<string | null>(null);

  return (
    <div className="flex h-full w-full bg-white rounded-lg shadow-lg overflow-hidden">
      {/* Chat List */}
      <div
        className={`w-full lg:w-80 border-r border-gray-200 flex flex-col ${selectedChat ? "hidden lg:flex" : "flex"}`}
      >
        <div className="h-[60px] flex items-center bg-gray-200 px-4">
          <h2 className="text-lg font-semibold">Chats</h2>
          <div className="relative flex-1 ml-4">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              type="search"
              placeholder="Search chats"
              className="pl-9 w-full text-sm"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {["John Doe", "Jane Doe", "Bob Smith", "Sarah Johnson"].map(
            (name, index) => (
              <button
                key={index}
                onClick={() => setSelectedChat(name)}
                className="w-full flex items-center gap-3 p-4 hover:bg-gray-50 transition-colors border-b border-gray-200 last:border-0"
              >
                <Avatar>
                  <AvatarImage src="/placeholder-user.jpg" alt={name} />
                  <AvatarFallback>
                    {name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0 text-left">
                  <div className="font-medium">{name}</div>
                  <div className="text-sm text-gray-500 truncate">
                    Last message preview...
                  </div>
                </div>
                <div className="text-xs text-gray-400">{`${index + 1}:${index * 15} PM`}</div>
              </button>
            ),
          )}
        </div>
      </div>

      {/* Chat Window */}
      <div className={`flex-1 ${selectedChat ? "flex" : "hidden lg:flex"}`}>
        <div className="flex flex-col w-full">
          <div className="h-[60px] flex items-center justify-between bg-gray-200 px-4">
            <div className="flex items-center gap-3">
              {selectedChat && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="lg:hidden mr-1"
                  onClick={() => setSelectedChat(null)}
                >
                  <ArrowLeftIcon className="w-5 h-5" />
                  <span className="sr-only">Back to chat list</span>
                </Button>
              )}
              <Avatar>
                <AvatarImage src="/placeholder-user.jpg" alt="John Doe" />
                <AvatarFallback>JD</AvatarFallback>
              </Avatar>
              <div>
                <div className="font-medium">John Doe</div>
                <div className="text-sm text-gray-500">
                  Last seen 2 hours ago
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="hidden sm:inline-flex"
              >
                <PhoneIcon className="w-5 h-5" />
                <span className="sr-only">Call</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="hidden sm:inline-flex"
              >
                <VideoIcon className="w-5 h-5" />
                <span className="sr-only">Video call</span>
              </Button>
              <Button variant="ghost" size="icon">
                <MoveHorizontalIcon className="w-5 h-5" />
                <span className="sr-only">More options</span>
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {[
              { text: "Hey, how's it going?", sender: "them", time: "2:30 PM" },
              {
                text: "I'm doing great, thanks for asking!",
                sender: "me",
                time: "2:31 PM",
              },
              {
                text: "Did you see the new update?",
                sender: "them",
                time: "2:32 PM",
              },
              {
                text: "Yeah, it looks really cool! I can't wait to try it out.",
                sender: "me",
                time: "2:33 PM",
              },
            ].map((message, index) => (
              <div
                key={index}
                className={`flex ${message.sender === "me" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[70%] rounded-lg px-4 py-2 ${
                    message.sender === "me"
                      ? "bg-blue-500 text-white"
                      : "bg-gray-100"
                  }`}
                >
                  <p>{message.text}</p>
                  <div
                    className={`text-xs mt-1 ${
                      message.sender === "me"
                        ? "text-blue-100"
                        : "text-gray-500"
                    }`}
                  >
                    {message.time}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-200">
            <div className="p-4 flex gap-2">
              <Input placeholder="Type your message..." className="flex-1" />
              <Button size="icon" className="shrink-0">
                <SendIcon className="w-5 h-5" />
                <span className="sr-only">Send</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
