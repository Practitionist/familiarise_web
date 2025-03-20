"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import { useChatContext } from "stream-chat-react";

type User = {
  id: string;
  name?: string;
  image?: string;
};

interface CreateDirectMessageDialogProps {
  onChannelCreated?: () => void;
}

export const CreateDirectMessageDialog = ({ onChannelCreated }: CreateDirectMessageDialogProps) => {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const { client, setActiveChannel } = useChatContext();
  const { toast } = useToast();

  const handleSearch = async () => {
    if (!client || !searchTerm.trim()) return;
    
    setIsSearching(true);
    
    try {
      console.log("Searching for users with term:", searchTerm);
      
      // First try to search using Stream's built-in search
      const response = await client.queryUsers(
        { 
          $or: [
            { name: { $autocomplete: searchTerm } },
            { id: { $autocomplete: searchTerm } }
          ],
          id: { $ne: client.userID || "" } // Exclude current user
        },
        { id: 1 },
        { limit: 10 }
      );
      
      console.log("Stream search results:", response.users);
      
      // If no results found, try to search using our API
      if (response.users.length === 0) {
        try {
          console.log("No users found in Stream, trying API search");
          const apiResponse = await fetch(`/api/user/search?term=${encodeURIComponent(searchTerm)}`);
          
          if (apiResponse.ok) {
            const data = await apiResponse.json();
            console.log("API search results:", data.users);
            
            if (data.users && data.users.length > 0) {
              // We don't need to upsert users here anymore
              // The API has already done that for us
              console.log("Users found via API search:", data.users.length);
              
              // Return the users from our API
              return setUsers(data.users.map((user: any) => ({
                id: user.id,
                name: user.name || user.id,
                image: user.image
              })));
            }
          } else {
            console.error("API search failed:", await apiResponse.text());
          }
        } catch (apiError) {
          console.error("Error searching users via API:", apiError);
        }
      }
      
      setUsers(response.users.map(user => ({
        id: user.id,
        name: user.name || user.id,
        image: user.image
      })));
    } catch (error) {
      console.error("Error searching users:", error);
      toast({
        title: "Error",
        description: "Failed to search users. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSearching(false);
    }
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUsers(prev => 
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const handleCreateDirectMessage = async () => {
    if (!client) {
      toast({
        title: "Error",
        description: "Chat client not initialized",
        variant: "destructive",
      });
      return;
    }
    
    if (selectedUsers.length === 0) {
      toast({
        title: "Error",
        description: "Please select at least one user",
        variant: "destructive",
      });
      return;
    }
    
    setIsLoading(true);
    
    try {
      // First, ensure all selected users are upserted to Stream Chat
      for (const userId of selectedUsers) {
        try {
          // Use the server-side API to upsert the user
          const response = await fetch('/api/stream/upsert-user', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ userId }),
          });
          
          if (!response.ok) {
            console.error(`Failed to upsert user ${userId}:`, await response.text());
          }
        } catch (error) {
          console.error(`Error upserting user ${userId}:`, error);
          // Continue even if upserting fails for one user
        }
      }
      
      // Also upsert the current user
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
      
      // Include current user in members
      const members = [client.userID || "", ...selectedUsers];
      
      // Create a unique channel ID based on sorted member IDs
      const channelId = members.sort().join("-");
      
      // Create a new direct message channel
      const channel = client.channel("messaging", channelId, {
        members,
        created_by_id: client.userID,
      });
      
      await channel.create();
      
      // Set the new channel as active
      setActiveChannel(channel);
      
      toast({
        title: "Success",
        description: "Direct message created successfully",
      });
      
      // Call the onChannelCreated callback if provided
      if (onChannelCreated) {
        onChannelCreated();
      }
      
      // Close the dialog
      setOpen(false);
      setSearchTerm("");
      setSelectedUsers([]);
    } catch (error) {
      console.error("Error creating direct message:", error);
      toast({
        title: "Error",
        description: "Failed to create direct message. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Handle Enter key in search input
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSearch();
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
          <DialogTitle>Create Direct Message</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="searchUsers">Search Users</Label>
            <div className="flex space-x-2">
              <Input
                id="searchUsers"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search by name or ID"
                disabled={isSearching || isLoading}
                onKeyDown={handleKeyDown}
              />
              <Button 
                type="button" 
                variant="outline" 
                onClick={handleSearch}
                disabled={isSearching || isLoading}
              >
                <SearchIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>
          
          {isSearching ? (
            <div className="py-4 text-center">
              <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-primary mx-auto"></div>
              <p className="text-sm text-gray-500 mt-2">Searching users...</p>
            </div>
          ) : users.length > 0 ? (
            <div className="max-h-60 overflow-y-auto border rounded-md p-2">
              {users.map(user => (
                <div 
                  key={user.id} 
                  className="flex items-center space-x-2 p-2 hover:bg-gray-100 rounded-md cursor-pointer"
                  onClick={() => toggleUserSelection(user.id)}
                >
                  <Checkbox 
                    id={`user-${user.id}`}
                    checked={selectedUsers.includes(user.id)}
                    onCheckedChange={() => toggleUserSelection(user.id)}
                  />
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={user.image || "/placeholder-user.jpg"} />
                    <AvatarFallback>{user.name?.charAt(0) || user.id.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <Label 
                    htmlFor={`user-${user.id}`}
                    className="cursor-pointer flex-1"
                  >
                    {user.name || user.id}
                  </Label>
                </div>
              ))}
            </div>
          ) : searchTerm ? (
            <p className="text-sm text-gray-500 py-4 text-center">No users found. Try a different search term.</p>
          ) : null}
          
          <Button 
            type="button" 
            className="w-full" 
            disabled={isLoading || selectedUsers.length === 0}
            onClick={handleCreateDirectMessage}
          >
            {isLoading ? "Creating..." : "Create Direct Message"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
