"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  hasRelationship?: boolean;
};

interface CreateDirectMessageDialogProps {
  onChannelCreated?: () => void;
}

export const CreateDirectMessageDialog = ({
  onChannelCreated,
}: CreateDirectMessageDialogProps) => {
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
      const streamUserResponse = await client.queryUsers(
        {
          $and: [
            { id: { $ne: client.userID || "" } }, // Exclude current user
            // Add role-based exclusion if you have specific roles for system/bot users
            // For example: { role: { $ne: "bot" } },
            // { role: { $ne: "system_agent" } },
            {
              $or: [
                { name: { $autocomplete: searchTerm } },
                { id: { $autocomplete: searchTerm } }, // Standard autocomplete for ID
              ],
            },
          ],
        },
        { last_active: -1, name: 1 }, // Sort by last active, then by name
        { limit: 20 }, // Fetch a bit more to allow for potential client-side filtering if needed
      );

      // Client-side filter for unwanted patterns if Stream query is too broad
      const filteredStreamUsers = streamUserResponse.users.filter(
        (user) =>
          !user.id.startsWith("recording-egress-") &&
          !user.id.startsWith("system-"),
        // Add other ID patterns to exclude if necessary
      );

      console.log("Filtered Stream search results:", filteredStreamUsers);

      if (filteredStreamUsers.length > 0) {
        setUsers(
          filteredStreamUsers.map((user) => ({
            id: user.id,
            name: user.name || user.id,
            image: user.image as string | undefined, // Cast image type
          })),
        );
        // No need to call API if Stream search yielded results after filtering
        setIsSearching(false);
        return;
      }

      // If no results from Stream search (or after client-side filtering), try API search with relationships
      console.log("No relevant users found in Stream, trying API search with relationships");
      const apiResponse = await fetch(
        `/api/stream/search?term=${encodeURIComponent(searchTerm)}&relationships=true`,
      );

      if (apiResponse.ok) {
        const data = await apiResponse.json();
        console.log("API search results:", data.users);
        if (data.users && data.users.length > 0) {
          setUsers(
            data.users.map((user: any) => ({
              id: user.id,
              name: user.name || user.id,
              image: user.image,
              hasRelationship: user.hasRelationship || false,
            })),
          );
        } else {
          setUsers([]); // No users from API either
        }
      } else {
        console.error("API search failed:", await apiResponse.text());
        setUsers([]);
        toast({
          title: "Error",
          description: "API user search failed.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error searching users:", error);
      toast({
        title: "Error",
        description: "Failed to search users. Please try again.",
        variant: "destructive",
      });
      setUsers([]); // Clear users on error
    } finally {
      setIsSearching(false);
    }
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUsers((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId],
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

    const currentUserId = client.userID;
    if (!currentUserId) {
      toast({
        title: "Error",
        description: "Current user ID not found",
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
      // Include current user in members
      const members = [currentUserId, ...selectedUsers];

      // Create a unique channel ID based on sorted member IDs
      const channelId = members.sort().join("-");

      console.log(
        `Creating messaging channel: ${channelId} with members:`,
        members,
      );
      // Create a new direct message channel
      const channel = client.channel("messaging", channelId, {
        members,
        created_by_id: currentUserId,
        // Optionally add a name for group DMs if needed
        // name: members.length > 2 ? "Group Chat" : undefined,
      });

      // Use watch() instead of create() for messaging channels
      // watch() creates the channel if it doesn't exist and watches for events
      await channel.watch();
      console.log(`Watched channel ${channel.cid}`);

      // Set the new channel as active
      setActiveChannel(channel);

      toast({
        title: "Success",
        description: "Direct message channel ready",
      });

      // Call the onChannelCreated callback if provided
      if (onChannelCreated) {
        onChannelCreated();
      }

      // Close the dialog and reset state
      setOpen(false);
      setSearchTerm("");
      setSelectedUsers([]);
      setUsers([]);
    } catch (error) {
      console.error("Error creating/watching direct message channel:", error);
      toast({
        title: "Error",
        description:
          "Failed to create direct message channel. Please try again.",
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
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) {
          // Reset state when closing
          setSearchTerm("");
          setSelectedUsers([]);
          setUsers([]);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="p-1 text-white hover:bg-blue-700"
        >
          <PlusIcon className="h-4 w-4 mr-1" /> DM
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create Direct Message</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-4">
          <div className="flex space-x-2">
            <Input
              id="searchUsers"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search users by name or ID"
              disabled={isLoading}
            />
            <Button
              type="button"
              onClick={handleSearch}
              disabled={isLoading || isSearching || !searchTerm.trim()}
            >
              {isSearching ? (
                "Searching..."
              ) : (
                <SearchIcon className="h-4 w-4" />
              )}
            </Button>
          </div>

          {users.length > 0 && (
            <div className="max-h-60 overflow-y-auto border rounded-md p-2 space-y-2">
              <Label>Select Users:</Label>
              {users.map((user) => (
                <div
                  key={user.id}
                  className={`flex items-center space-x-2 p-1 rounded hover:bg-slate-100 ${
                    user.hasRelationship === false 
                      ? "opacity-50" 
                      : ""
                  }`}
                  title={
                    user.hasRelationship === false
                      ? "No appointment relationship with this user"
                      : user.hasRelationship
                      ? "Connected through appointments"
                      : ""
                  }
                >
                  <Checkbox
                    id={`user-${user.id}`}
                    checked={selectedUsers.includes(user.id)}
                    onCheckedChange={() => toggleUserSelection(user.id)}
                    disabled={isLoading}
                  />
                  <Avatar className="w-8 h-8">
                    <AvatarImage src={user.image} />
                    <AvatarFallback>{user.name?.charAt(0)}</AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col">
                    <Label htmlFor={`user-${user.id}`} className="cursor-pointer">
                      {user.name || "Unknown User"}
                    </Label>
                    {user.hasRelationship === true && (
                      <span className="text-xs text-green-600">
                        ✓ Connected
                      </span>
                    )}
                    {user.hasRelationship === false && (
                      <span className="text-xs text-gray-400">
                        No appointments
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {isSearching && <p>Searching for users...</p>}
          {!isSearching && searchTerm && users.length === 0 && (
            <p className="text-sm text-gray-500">
              No users found matching "{searchTerm}".
            </p>
          )}

          <Button
            onClick={handleCreateDirectMessage}
            className="w-full"
            disabled={isLoading || selectedUsers.length === 0}
          >
            {isLoading ? "Creating..." : "Start Direct Message"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
