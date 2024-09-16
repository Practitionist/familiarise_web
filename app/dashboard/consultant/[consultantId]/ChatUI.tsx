import React from 'react';
import Link from 'next/link';
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoveHorizontalIcon, SendIcon, PhoneIcon, VideoIcon, SearchIcon } from 'lucide-react';

const ChatUI: React.FC = () => (
  <div className="flex h-full w-full bg-white rounded-lg shadow-lg overflow-hidden">
    <div className="w-1/3 border-r">
      <header className="flex items-center justify-between px-4 py-3 bg-gray-100 border-b">
        <div className="font-bold text-lg">Chats</div>
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            type="search"
            placeholder="Search or start new chat"
            className="pl-10 pr-4 py-2 w-full text-sm bg-white"
          />
        </div>
      </header>
      <div className="h-[calc(100%-4rem)] overflow-y-auto">
        {['John Doe', 'Jane Doe', 'Bob Smith', 'Sarah Johnson'].map((name, index) => (
          <Link key={index} href="#" className="flex items-center gap-4 p-4 hover:bg-gray-100 transition-colors duration-200" prefetch={false}>
            <Avatar className="w-12 h-12">
              <AvatarImage src="/placeholder-user.jpg" alt={name} />
              <AvatarFallback>{name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="font-medium">{name}</div>
              <div className="text-sm text-gray-500 truncate">Last message preview...</div>
            </div>
            <div className="text-xs text-gray-400">{`${index + 1}:${index * 15} PM`}</div>
          </Link>
        ))}
      </div>
    </div>
    <div className="flex-1 flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 bg-gray-100 border-b">
        <div className="flex items-center gap-4">
          <Avatar className="w-10 h-10">
            <AvatarImage src="/placeholder-user.jpg" alt="John Doe" />
            <AvatarFallback>JD</AvatarFallback>
          </Avatar>
          <div>
            <div className="font-medium">John Doe</div>
            <div className="text-xs text-gray-500">Last seen 2 hours ago</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon">
            <PhoneIcon className="w-5 h-5" />
            <span className="sr-only">Call</span>
          </Button>
          <Button variant="ghost" size="icon">
            <VideoIcon className="w-5 h-5" />
            <span className="sr-only">Video call</span>
          </Button>
          <Button variant="ghost" size="icon">
            <MoveHorizontalIcon className="w-5 h-5" />
            <span className="sr-only">More options</span>
          </Button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {[
          { text: "Hey, how's it going?", sender: 'them', time: '2:30 PM' },
          { text: "I'm doing great, thanks for asking!", sender: 'me', time: '2:31 PM' },
          { text: "Did you see the new update?", sender: 'them', time: '2:32 PM' },
          { text: "Yeah, it looks really cool! I can't wait to try it out.", sender: 'me', time: '2:33 PM' },
        ].map((message, index) => (
          <div key={index} className={`flex ${message.sender === 'me' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[70%] rounded-lg px-4 py-2 ${message.sender === 'me' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}>
              <p>{message.text}</p>
              <div className={`text-xs mt-1 ${message.sender === 'me' ? 'text-blue-100' : 'text-gray-500'}`}>{message.time}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="border-t p-4">
        <form className="flex items-center gap-2">
          <Input 
            placeholder="Type your message..." 
            className="flex-1"
          />
          <Button type="submit" size="icon">
            <SendIcon className="w-5 h-5" />
            <span className="sr-only">Send</span>
          </Button>
        </form>
      </div>
    </div>
  </div>
);

export default ChatUI;