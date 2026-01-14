"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import {
  AlertTriangleIcon,
  BellIcon,
  BellOffIcon,
  InfoIcon,
  Loader2Icon,
  Trash2Icon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { Channel } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { getChannelDisplayInfo } from "./utils/channelUtils";

interface ChannelInfoAndManageDialogProps {
  channel: Channel;
}

export const ChannelInfoAndManageDialog = ({
  channel,
}: ChannelInfoAndManageDialogProps) => {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLeavingChannel, setIsLeavingChannel] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const { client, setActiveChannel } = useChatContext();
  const { toast } = useToast();
  const [members, setMembers] = useState<any[]>([]);

  const isTeamChannel = channel.type === "team";
  const isDirectMessage = channel.type === "messaging";
  const isEventChannel =
    channel.id?.startsWith("webinar-") || channel.id?.startsWith("class-");
  const memberCount = Object.keys(channel.state.members || {}).length;

  // Get display info using shared utility
  const displayInfo = isDirectMessage
    ? getChannelDisplayInfo(channel, client?.userID)
    : {
        displayName: channel.data?.name || channel.id || "",
        isGroupDM: false,
        memberCount,
        statusText: `${memberCount} ${memberCount === 1 ? "member" : "members"}`,
        fullGroupName: undefined,
      };

  const displayName = displayInfo.displayName;

  // Check if current user is the event owner consultant
  const isEventOwner =
    isEventChannel &&
    channel.data?.created_by_id === client?.userID &&
    client?.user?.role === "CONSULTANT";

  // Get the other user's ID for 1-on-1 DMs (for block/report)
  const otherUserId =
    isDirectMessage && !displayInfo.isGroupDM
      ? Object.keys(channel.state.members || {}).find(
          (id) => id !== client?.userID
        )
      : null;

  // Check if channel is muted
  const isMuted = channel.muteStatus()?.muted ?? false;

  // Load members when dialog opens
  const handleOpenChange = (open: boolean) => {
    setOpen(open);
    if (open) {
      loadMembers();
    }
  };

  const loadMembers = async () => {
    setIsLoading(true);
    try {
      const members = Object.values(channel.state.members || {}).map(
        (member) => member.user,
      );
      setMembers(members);
    } catch (error) {
      console.error("Error loading members:", error);
      toast({
        title: "Error",
        description: "Failed to load channel members",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddMember = async () => {
    // This would typically open another dialog to search and select users
    toast({
      title: "Info",
      description: "Add member functionality would be implemented here",
    });
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!client?.userID || !isEventOwner) return;

    setIsLoading(true);
    try {
      await channel.removeMembers([memberId]);
      toast({
        title: "Success",
        description: "Member removed successfully",
      });
      // Refresh the member list
      loadMembers();
    } catch (error) {
      console.error("Error removing member:", error);
      toast({
        title: "Error",
        description: "Failed to remove member",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLeaveChannel = async () => {
    if (!client?.userID) return;

    setIsLoading(true);
    setIsLeavingChannel(true);
    try {
      // Remove the user from the channel members
      await channel.removeMembers([client.userID]);

      // Set active channel to undefined to show empty state
      setActiveChannel(undefined);

      toast({
        title: "Success",
        description: "You have left the channel",
        variant: "default",
      });

      // Close the dialog
      setOpen(false);
    } catch (error) {
      console.error("Error leaving channel:", error);
      toast({
        title: "Error",
        description: "Failed to leave the channel",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
      setIsLeavingChannel(false);
    }
  };

  // Clear all messages from the channel
  const handleClearChat = async () => {
    setIsLoading(true);
    try {
      await channel.truncate();
      toast({
        title: "Chat cleared",
        description: "All messages have been removed",
      });
      setShowClearConfirm(false);
    } catch (error) {
      console.error("Error clearing chat:", error);
      toast({
        title: "Error",
        description: "Failed to clear chat",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Report the other user in a 1-on-1 DM
  const handleReportUser = async () => {
    if (!client || !otherUserId) return;

    setIsLoading(true);
    try {
      await client.flagUser(otherUserId, { reason: "user_report" });
      toast({
        title: "User reported",
        description: "Our team will review this report",
      });
    } catch (error) {
      console.error("Error reporting user:", error);
      toast({
        title: "Error",
        description: "Failed to report user",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Toggle mute/unmute for event channels
  const handleMuteChannel = async () => {
    setIsLoading(true);
    try {
      if (isMuted) {
        await channel.unmute();
        toast({
          title: "Notifications enabled",
          description: "You will receive notifications from this channel",
        });
      } else {
        await channel.mute();
        toast({
          title: "Channel muted",
          description: "You will no longer receive notifications",
        });
      }
    } catch (error) {
      console.error("Error toggling mute:", error);
      toast({
        title: "Error",
        description: "Failed to update notification settings",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogTrigger asChild>
          <button className="p-2 rounded-full hover:bg-gray-100">
            <InfoIcon className="h-5 w-5 text-gray-500" />
          </button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {isTeamChannel ? (
                <div className="flex items-center">
                  <span className="text-gray-500 mr-2">#</span>
                  <span>{displayName}</span>
                </div>
              ) : displayInfo.isGroupDM ? (
                <div className="flex items-center">
                  <UsersIcon className="h-4 w-4 text-gray-500 mr-2" />
                  <span className="truncate">{displayName}</span>
                </div>
              ) : (
                <span>{displayName}</span>
              )}
            </DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="info" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="info">Information</TabsTrigger>
              <TabsTrigger value="members">Members ({memberCount})</TabsTrigger>
            </TabsList>

            <TabsContent value="info" className="space-y-4 py-4">
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Channel Type</h3>
                <p className="text-sm text-gray-500">
                  {isTeamChannel
                    ? "Team Channel"
                    : displayInfo.isGroupDM
                      ? "Group Direct Message"
                      : "Direct Message"}
                  {isEventChannel && " (Event Channel)"}
                </p>
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-medium">Created</h3>
                <p className="text-sm text-gray-500">
                  {channel.data?.created_at &&
                  typeof channel.data.created_at === "string"
                    ? new Date(channel.data.created_at).toLocaleString()
                    : "Unknown"}
                </p>
              </div>

              <div className="pt-4">
                <h3 className="text-sm font-medium mb-2">
                  {isDirectMessage && displayInfo.isGroupDM
                    ? "Group Actions"
                    : "Channel Actions"}
                </h3>
                <div className="space-y-2">
                  {!isTeamChannel ? (
                    displayInfo.isGroupDM ? (
                      // Group DM Actions
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={() =>
                            toast({
                              title: "Info",
                              description:
                                "Add members functionality would be implemented here",
                            })
                          }
                          disabled={isLoading}
                        >
                          <UserPlusIcon className="h-4 w-4" />
                          Add Members
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={() =>
                            toast({
                              title: "Info",
                              description:
                                "Clear chat functionality would be implemented here",
                            })
                          }
                          disabled={isLoading}
                        >
                          <Trash2Icon className="h-4 w-4" />
                          Clear Chat
                        </Button>

                        <Button
                          variant="destructive"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={handleLeaveChannel}
                          disabled={isLoading}
                        >
                          <UserMinusIcon className="h-4 w-4" />
                          Leave Group
                        </Button>
                      </>
                    ) : (
                      // Individual DM Actions
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={() => setShowClearConfirm(true)}
                          disabled={isLoading}
                        >
                          <Trash2Icon className="h-4 w-4" />
                          Clear Chat
                        </Button>

                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full flex items-center justify-center gap-2"
                          onClick={handleReportUser}
                          disabled={isLoading || !otherUserId}
                        >
                          <AlertTriangleIcon className="h-4 w-4" />
                          Report User
                        </Button>
                      </>
                    )
                  ) : (
                    // Team/Event Channel Actions
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full flex items-center justify-center gap-2"
                        onClick={handleMuteChannel}
                        disabled={isLoading}
                      >
                        {isMuted ? (
                          <>
                            <BellIcon className="h-4 w-4" />
                            Unmute Channel
                          </>
                        ) : (
                          <>
                            <BellOffIcon className="h-4 w-4" />
                            Mute Channel
                          </>
                        )}
                      </Button>

                      <Button
                        variant="destructive"
                        size="sm"
                        className="w-full flex items-center justify-center gap-2"
                        onClick={handleLeaveChannel}
                        disabled={isLoading}
                      >
                        <UserMinusIcon className="h-4 w-4" />
                        Leave Channel
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="members" className="space-y-4 py-4">
              {isLoading ? (
                <div className="py-4 text-center text-gray-500">
                  Loading members...
                </div>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between p-2 hover:bg-gray-50 rounded"
                    >
                      <div className="flex items-center">
                        <div className="w-8 h-8 rounded-full bg-gray-200 mr-3 flex items-center justify-center">
                          {member.image ? (
                            <img
                              src={member.image}
                              alt={member.name}
                              className="w-8 h-8 rounded-full"
                            />
                          ) : (
                            <span>
                              {member.name?.charAt(0) ||
                                member.id?.charAt(0) ||
                                "?"}
                            </span>
                          )}
                        </div>
                        <div>
                          <div className="font-medium">
                            {member.name || member.id}
                          </div>
                          <div className="text-xs text-gray-500">
                            {member.online ? "Online" : "Offline"}
                          </div>
                        </div>
                      </div>

                      {/* Show remove button for event owner consultants */}
                      {isEventOwner && member.id !== client?.userID && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => handleRemoveMember(member.id)}
                          disabled={isLoading}
                        >
                          <XIcon className="h-4 w-4 text-gray-500" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {isTeamChannel && (
                <div className="pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full flex items-center justify-center gap-2"
                    onClick={handleAddMember}
                    disabled={isLoading}
                  >
                    <UserPlusIcon className="h-4 w-4" />
                    Add Members
                  </Button>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Loading dialog for leaving channel */}
      <Dialog open={isLeavingChannel} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-[300px] [&>button]:hidden">
          <DialogHeader>
            <DialogTitle className="sr-only">Leaving Channel</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center py-6 space-y-4">
            <Loader2Icon className="h-8 w-8 animate-spin text-blue-500" />
            <p className="text-sm text-gray-600">Leaving channel...</p>
          </div>
        </DialogContent>
      </Dialog>

      {/* Clear Chat Confirmation Dialog */}
      <Dialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Clear chat history?</DialogTitle>
            <DialogDescription>
              This will remove all messages from this conversation. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setShowClearConfirm(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearChat}
              disabled={isLoading}
            >
              {isLoading ? (
                <Loader2Icon className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Clear Chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
