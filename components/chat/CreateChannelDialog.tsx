"use client";

import { Button } from "@/components/ui/button";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
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
import { useEffect, useMemo, useState } from "react";
import { useChatPane } from "./ChatPaneContext";
import { useChatContext } from "stream-chat-react";
import { useOrgScope } from "@/hooks/useOrgScope";
import { scopeOrgId } from "@/lib/api/scope/parse";

interface CreateChannelDialogProps {
  onChannelCreated?: () => void;
  /**
   * Whether the viewer may create a channel not bound to an event.
   *
   * `app/api/stream/channels/create/route.ts` restricts these to ADMIN/STAFF
   * so an unprivileged caller cannot assemble an arbitrary member list. The
   * option is hidden rather than left to fail, because a consultant selecting
   * it previously succeeded — the dialog created the channel client-side and
   * never consulted the route at all.
   */
  canCreateCustomChannel?: boolean;
}

export const CreateChannelDialog = ({
  onChannelCreated,
  canCreateCustomChannel = false,
}: CreateChannelDialogProps) => {
  const [open, setOpen] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { client, setActiveChannel } = useChatContext();
  // Creating a channel is an explicit "take me there". Below `md` the
  // conversation pane stays hidden until this runs, so without it the new
  // channel opens behind the list the dialog just closed over.
  const { openConversation } = useChatPane();
  const { scope } = useOrgScope({ defaultForOrgMember: "personal" });
  const { toast } = useToast();

  // Fetch user's events
  const {
    webinars,
    classes,
    isLoading: isLoadingEvents,
  } = useEventsByUser(client?.userID || "");

  // Prepare events for dropdown
  const events = useMemo(
    () => [
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
    ],
    [webinars, classes],
  );

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

  const createEventLinkedChannel = async (
    eventSelection: string,
    currentUserId: string,
    organizationId: string | null,
  ) => {
    if (!client) return;
    const separatorIndex = eventSelection.indexOf("-");
    const eventType =
      separatorIndex >= 0
        ? eventSelection.slice(0, separatorIndex)
        : eventSelection;
    const eventId =
      separatorIndex >= 0 ? eventSelection.slice(separatorIndex + 1) : "";

    const response = await fetch("/api/stream/channels/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelType: "team",
        eventType,
        eventId,
        createdById: currentUserId,
        organizationId,
      }),
    });

    const result = await response.json();

    if (!result.success) {
      throw new Error(result.error || "Failed to create channel");
    }

    const channelId = `${eventType}-${eventId}`;
    const channel = client.channel("team", channelId);

    try {
      await channel.query();
      setActiveChannel(channel);
      openConversation();
    } catch (queryError) {
      console.error("Error querying created channel:", queryError);
    }

    toast({
      title: "Success",
      description:
        result.message || `Channel "${channelName}" created successfully`,
    });
  };

  const createCustomTeamChannel = async (
    currentUserId: string,
    organizationId: string | null,
  ) => {
    if (!client) return;
    const response = await fetch("/api/stream/channels/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channelType: "team",
        channelName,
        createdById: currentUserId,
        organizationId,
      }),
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || "Failed to create channel");
    }

    const channel = client.channel("team", result.data.channelId);
    await channel.watch();

    setActiveChannel(channel);
    openConversation();

    toast({
      title: "Success",
      description: `Channel "${channelName}" created successfully`,
    });
  };

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
    const organizationId = scopeOrgId(scope);

    try {
      if (!selectedEvent) {
        toast({
          title: "Error",
          description: "Please choose what this channel is for",
          variant: "destructive",
        });
        return;
      }

      if (selectedEvent !== "custom") {
        await createEventLinkedChannel(
          selectedEvent,
          currentUserId,
          organizationId,
        );
      } else if (!canCreateCustomChannel) {
        toast({
          title: "Not allowed",
          description:
            "Only staff can create channels that aren't tied to an event",
          variant: "destructive",
        });
        return;
      } else {
        await createCustomTeamChannel(currentUserId, organizationId);
      }

      // Call the onChannelCreated callback if provided (this should trigger sidebar refresh for just this channel)
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
    // ResponsiveModal, so this becomes a bottom sheet on a phone instead of a
    // 425px-wide centred dialog squeezed onto a 375px screen.
    <ResponsiveModal
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
      <ResponsiveModalTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Create a channel"
          title="Create a channel"
          className="p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </ResponsiveModalTrigger>
      <ResponsiveModalContent className="sm:max-w-[425px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Create New Channel</ResponsiveModalTitle>
        </ResponsiveModalHeader>
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
                {canCreateCustomChannel && (
                  <SelectItem value="custom">
                    Create a Custom Channel
                  </SelectItem>
                )}
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
              <p className="text-xs text-muted-foreground">
                Channel name is set by the selected event.
              </p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? "Creating..." : "Create Channel"}
          </Button>
        </form>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
};
