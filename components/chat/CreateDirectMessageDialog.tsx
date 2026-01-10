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
import { PlusIcon, SearchIcon, InfoIcon } from "lucide-react";
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

  // Check if we're in development mode for bypassing relationship restrictions
  const isDevelopmentMode = process.env.NODE_ENV === "development";

  const handleSearch = async () => {
    if (!client || !searchTerm.trim()) return;

    setIsSearching(true);

    try {
      console.log("Searching for users with term:", searchTerm);

      // First try to search using Stream's built-in search
      // Note: $ne operator removed for performance (stream-chat v9 breaking change)
      // Filtering current user and unwanted patterns client-side instead
      const streamUserResponse = await client.queryUsers(
        {
          $or: [
            { name: { $autocomplete: searchTerm } },
            { id: { $autocomplete: searchTerm } },
          ],
        },
        { last_active: -1, name: 1 }, // Sort by last active, then by name
        { limit: 20 }, // Fetch a bit more to allow for client-side filtering
      );

      // Client-side filter for current user and unwanted patterns
      const filteredStreamUsers = streamUserResponse.users.filter(
        (user) =>
          user.id !== client.userID && // Exclude current user
          !user.id.startsWith("recording-egress-") &&
          !user.id.startsWith("system-"),
      );

      console.log("Filtered Stream search results:", filteredStreamUsers);

      if (filteredStreamUsers.length > 0) {
        // Deduplicate by user ID to prevent duplicate entries
        const uniqueStreamUsers = Array.from(
          new Map(filteredStreamUsers.map((u) => [u.id, u])).values(),
        );
        setUsers(
          uniqueStreamUsers.map((user) => ({
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
      console.log(
        "No relevant users found in Stream, trying API search with relationships",
      );
      const apiResponse = await fetch(
        `/api/stream/search?term=${encodeURIComponent(searchTerm)}&relationships=true`,
      );

      if (apiResponse.ok) {
        const data = await apiResponse.json();
        console.log("API search results:", data.users);
        if (data.users && data.users.length > 0) {
          // Deduplicate by user ID to prevent duplicate entries
          const uniqueApiUsers = Array.from(
            new Map(data.users.map((u: any) => [u.id, u])).values(),
          ) as any[];
          setUsers(
            uniqueApiUsers.map((user: any) => ({
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
    // In production, check if user has relationship before allowing selection
    const user = users.find((u) => u.id === userId);
    if (!isDevelopmentMode && user?.hasRelationship === false) {
      toast({
        title: "Unable to message",
        description:
          "You can only message consultants and consultees you're connected with through appointments.",
        variant: "destructive",
      });
      return;
    }

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

      // Create a unique channel ID that stays under Stream's 64 character limit
      const sortedMembers = members.sort();

      // For 1-on-1 chats, use a simple format with truncated IDs
      let channelId: string;
      if (sortedMembers.length === 2) {
        // For direct messages between 2 users, use first 8 chars of each ID
        const id1 = sortedMembers[0].substring(0, 8);
        const id2 = sortedMembers[1].substring(0, 8);
        channelId = `dm-${id1}-${id2}`;
      } else {
        // For group chats, create a hash-based ID
        const memberString = sortedMembers.join(",");
        // Simple hash function to create a shorter unique ID
        let hash = 0;
        for (let i = 0; i < memberString.length; i++) {
          const char = memberString.charCodeAt(i);
          hash = (hash << 5) - hash + char;
          hash = hash & hash; // Convert to 32-bit integer
        }
        const hashString = Math.abs(hash).toString(36);
        const timestamp = Date.now().toString(36).slice(-4); // Last 4 chars of timestamp
        channelId = `group-${hashString}-${timestamp}`;
      }

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

        {/* Professional Info Bar */}
        <div className="bg-blue-50 border border-blue-200 rounded-md p-3 flex items-start space-x-2">
          <InfoIcon className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-blue-800">
            <p className="font-medium">Messaging Guidelines</p>
            <p className="text-blue-700 mt-1">
              You can message consultants and consultees you're connected with
              through appointments or waitlists.
              {isDevelopmentMode && (
                <span className="block mt-1 text-blue-600 font-medium">
                  Development Mode: All users are available for messaging.
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="space-y-4">
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
              {users.map((user) => {
                const isDisabledInProduction =
                  !isDevelopmentMode && user.hasRelationship === false;
                return (
                  <div
                    key={user.id}
                    className={`flex items-center space-x-2 p-1 rounded transition-colors ${
                      isDisabledInProduction
                        ? "opacity-50 cursor-not-allowed bg-gray-50"
                        : "hover:bg-slate-100 cursor-pointer"
                    }`}
                    title={
                      isDisabledInProduction
                        ? "You can only message users you're connected with through appointments"
                        : user.hasRelationship
                          ? "Connected through appointments"
                          : isDevelopmentMode
                            ? "Development mode: All users available"
                            : ""
                    }
                  >
                    <Checkbox
                      id={`user-${user.id}`}
                      checked={selectedUsers.includes(user.id)}
                      onCheckedChange={() => toggleUserSelection(user.id)}
                      disabled={isLoading || isDisabledInProduction}
                    />
                    <Avatar className="w-8 h-8">
                      <AvatarImage src={user.image} />
                      <AvatarFallback>{user.name?.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <Label
                        htmlFor={`user-${user.id}`}
                        className={
                          isDisabledInProduction
                            ? "cursor-not-allowed"
                            : "cursor-pointer"
                        }
                      >
                        {user.name || "Unknown User"}
                      </Label>
                      {user.hasRelationship === true && (
                        <span className="text-xs text-green-600">
                          ✓ Connected
                        </span>
                      )}
                      {user.hasRelationship === false && (
                        <span className="text-xs text-gray-400">
                          {isDevelopmentMode
                            ? "No appointments (Dev bypass)"
                            : "No appointments"}
                        </span>
                      )}
                      {isDevelopmentMode &&
                        user.hasRelationship === undefined && (
                          <span className="text-xs text-blue-500">
                            Development mode
                          </span>
                        )}
                    </div>
                  </div>
                );
              })}
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
