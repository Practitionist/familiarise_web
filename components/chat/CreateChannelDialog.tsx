"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useEventsByUser } from "@/hooks/useEvents";
import { PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useChatContext } from "stream-chat-react";

interface CreateChannelDialogProps {
  onChannelCreated?: () => void;
}

export const CreateChannelDialog = ({
  onChannelCreated,
}: CreateChannelDialogProps) => {
  const [open, setOpen] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { client, setActiveChannel } = useChatContext();
  const { toast } = useToast();

  // Fetch user's events
  const {
    webinars,
    classes,
    isLoading: isLoadingEvents,
  } = useEventsByUser(client?.userID || "");

  // Prepare events for dropdown
  const events = [
    ...webinars.map((webinar) => ({
      id: `webinar-${webinar.id}`,
      name: webinar.webinarPlan.title,
      type: "webinar",
    })),
    ...classes.map((classItem) => ({
      id: `class-${classItem.id}`,
      name: classItem.classPlan.title,
      type: "class",
    })),
  ];

  // Update channel name when event is selected
  useEffect(() => {
    if (selectedEvent && selectedEvent !== "custom") {
      const event = events.find((e) => e.id === selectedEvent);
      if (event) {
        setChannelName(event.name);
      } else {
        // Handle case where selectedEvent might be invalid (e.g., event deleted)
        setChannelName("");
        setSelectedEvent(null); // Reset selection
      }
    } else if (selectedEvent === "custom") {
      // Allow manual entry if "Custom Channel" is selected
      // Optionally clear the name if you want them to start fresh
      // setChannelName("");
    } else {
      // No event selected or selection cleared
      // setChannelName(""); // Optional: Clear name if needed
    }
  }, [selectedEvent, events]);

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();

    const currentUserId = client?.userID;

    if (!currentUserId) {
      toast({
        title: "Error",
        description: "Chat client or user not initialized",
        variant: "destructive",
      });
      return;
    }

    if (!channelName.trim()) {
      toast({
        title: "Error",
        description: "Please enter a channel name",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);

    try {
      // OPTIMIZATION: Removed explicit upsert block.
      // Stream's client.channel().create() typically handles creating the user if they don't exist.
      /*
      console.log("Ensuring current user exists in Stream via action...");
      try {
        await upsertUserToStream(currentUserId);
        } catch (error) {
        console.warn(
          `Could not upsert current user ${currentUserId} via action:`, error
        );
        // Allow proceeding, Stream might handle it
      }
      */

      // Determine channel ID based on selection
      // Use a UUID for custom channels to avoid potential naming conflicts
      const channelId =
        selectedEvent && selectedEvent !== "custom"
          ? selectedEvent
          : crypto.randomUUID();

      console.log(
        `Creating team channel: ${channelId} with name: ${channelName}`,
      );

      // Create a new team channel
      const dataForChannelCreation: Record<string, any> = {
        members: [currentUserId], // Start with only the creator
        created_by_id: currentUserId,
      };

      if (channelName) {
        dataForChannelCreation.name = channelName;
      }

      if (selectedEvent && selectedEvent !== "custom") {
        const eventParts = selectedEvent.split("-");
        dataForChannelCreation.event_id = eventParts.pop(); // e.g., webinarId or classId
        dataForChannelCreation.event_type = eventParts[0]; // e.g., 'webinar' or 'class'
      }

      const channel = client.channel("team", channelId, dataForChannelCreation);

      await channel.create();
      console.log(`Created channel ${channel.cid}`);

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

      // Close the dialog and reset state
      setOpen(false);
      setChannelName("");
      setSelectedEvent(null);
    } catch (error) {
      console.error("Error creating channel:", error);
      toast({
        title: "Error",
        description: `Failed to create channel: ${(error as Error).message}. Please try again.`,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (!isOpen) {
          // Reset state when dialog closes
          setChannelName("");
          setSelectedEvent(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="p-1 text-white hover:bg-blue-700"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create New Channel</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleCreateChannel} className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="eventSelect">
              Link to Webinar or Class (Optional)
            </Label>
            <Select
              value={selectedEvent || "custom"} // Default to 'custom'
              onValueChange={(value) => setSelectedEvent(value)}
              disabled={isLoadingEvents || isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a webinar or class" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="custom">Create a Custom Channel</SelectItem>
                {events.length > 0 ? (
                  events.map((event) => (
                    <SelectItem key={event.id} value={event.id}>
                      {event.name} ({event.type})
                    </SelectItem>
                  ))
                ) : (
                  <SelectItem value="no-events" disabled>
                    {isLoadingEvents ? "Loading events..." : "No events found"}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="channelName">Channel Name</Label>
            <Input
              id="channelName"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="Enter channel name"
              disabled={
                isLoading || (!!selectedEvent && selectedEvent !== "custom")
              }
              required // Make name required
            />
            {selectedEvent && selectedEvent !== "custom" && (
              <p className="text-xs text-gray-500">
                Channel name is set by the selected event.
              </p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Creating..." : "Create Channel"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
};
