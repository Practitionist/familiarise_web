"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useChatContext } from "stream-chat-react";

interface CreateChannelDialogProps {
  onChannelCreated?: () => void;
}

export const CreateChannelDialog = ({ onChannelCreated }: CreateChannelDialogProps) => {
  const [open, setOpen] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { client, setActiveChannel } = useChatContext();
  const { toast } = useToast();

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!channelName.trim()) {
      toast({
        title: "Error",
        description: "Please enter a channel name",
        variant: "destructive",
      });
      return;
    }
    
    if (!client) {
      toast({
        title: "Error",
        description: "Chat client not initialized",
        variant: "destructive",
      });
      return;
    }
    
    setIsLoading(true);
    
    try {
      // First, ensure the current user is upserted to Stream Chat
      if (client.userID) {
        try {
          const response = await fetch('/api/stream/upsert-user', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ userId: client.userID }),
          });
          
          if (!response.ok) {
            console.error(`Failed to upsert current user:`, await response.text());
          }
        } catch (error) {
          console.error(`Error upserting current user:`, error);
        }
      }
      
      // Create a new team channel
      const channel = client.channel("team", channelName.toLowerCase().replace(/\s+/g, "-"), {
        name: channelName,
        members: [client.userID || ""],
        created_by_id: client.userID,
      });
      
      await channel.create();
      
      // Set the new channel as active
      setActiveChannel(channel);
      
      toast({
        title: "Success",
        description: `Channel "${channelName}" created successfully`,
      });
      
      // Call the onChannelCreated callback if provided
      if (onChannelCreated) {
        onChannelCreated();
      }
      
      // Close the dialog
      setOpen(false);
      setChannelName("");
    } catch (error) {
      console.error("Error creating channel:", error);
      toast({
        title: "Error",
        description: "Failed to create channel. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="p-1 text-white hover:bg-blue-700">
          <PlusIcon className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create New Channel</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleCreateChannel} className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="channelName">Channel Name</Label>
            <Input
              id="channelName"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="Enter channel name"
              disabled={isLoading}
            />
          </div>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Creating..." : "Create Channel"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
};
