"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { InfoIcon, UserPlusIcon, UserMinusIcon, UsersIcon, Trash2Icon, BanIcon, AlertTriangleIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Channel } from "stream-chat";
import { useChatContext } from "stream-chat-react";

interface ChannelInfoAndManageDialogProps {
  channel: Channel;
}

export const ChannelInfoAndManageDialog = ({ channel }: ChannelInfoAndManageDialogProps) => {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { client } = useChatContext();
  const { toast } = useToast();
  const [members, setMembers] = useState<any[]>([]);

  const isTeamChannel = channel.type === 'team';
  const isDirectMessage = channel.type === 'messaging';
  const isEventChannel = channel.id?.startsWith('webinar-') || channel.id?.startsWith('class-');
  const memberCount = Object.keys(channel.state.members || {}).length;
  
  // Get a user-friendly display name for the channel
  let displayName = channel.data?.name || '';
  
  // For direct messages, use the other user's name
  if (isDirectMessage && client) {
    const otherMember = Object.values(channel.state.members || {}).find(
      (member) => member.user?.id !== client.userID
    )?.user;
    
    if (otherMember) {
      displayName = otherMember.name || otherMember.id || 'Unknown User';
    }
  }
  
  // Fallback to channel ID if no name is available
  if (!displayName) {
    displayName = channel.id || '';
  }
  
  // Check if current user is the event owner consultant
  const isEventOwner = isEventChannel && 
    channel.data?.created_by_id === client?.userID && 
    client?.user?.role === 'CONSULTANT';

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
      const members = Object.values(channel.state.members || {}).map(member => member.user);
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
    try {
      await channel.removeMembers([client.userID]);
      toast({
        title: "Success",
        description: "You have left the channel",
      });
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
    }
  };

  return (
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
                {isTeamChannel ? 'Team Channel' : 'Direct Message'}
                {isEventChannel && ' (Event Channel)'}
              </p>
            </div>
            
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Created</h3>
              <p className="text-sm text-gray-500">
                {channel.data?.created_at && typeof channel.data.created_at === 'string'
                  ? new Date(channel.data.created_at).toLocaleString() 
                  : 'Unknown'}
              </p>
            </div>
            
            <div className="pt-4">
              <h3 className="text-sm font-medium mb-2">Channel Actions</h3>
              <div className="space-y-2">
                {!isTeamChannel ? (
                  // Direct Message Actions
                  <>
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="w-full flex items-center justify-center gap-2"
                      onClick={() => toast({ title: "Info", description: "Clear chat functionality would be implemented here" })}
                      disabled={isLoading}
                    >
                      <Trash2Icon className="h-4 w-4" />
                      Clear Chat
                    </Button>
                    
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="w-full flex items-center justify-center gap-2"
                      onClick={() => toast({ title: "Info", description: "Delete chat functionality would be implemented here" })}
                      disabled={isLoading}
                    >
                      <XIcon className="h-4 w-4" />
                      Delete Chat
                    </Button>
                    
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="w-full flex items-center justify-center gap-2"
                      onClick={() => toast({ title: "Info", description: "Report user functionality would be implemented here" })}
                      disabled={isLoading}
                    >
                      <AlertTriangleIcon className="h-4 w-4" />
                      Report User
                    </Button>
                    
                    <Button 
                      variant="destructive" 
                      size="sm" 
                      className="w-full flex items-center justify-center gap-2"
                      onClick={() => toast({ title: "Info", description: "Block user functionality would be implemented here" })}
                      disabled={isLoading}
                    >
                      <BanIcon className="h-4 w-4" />
                      Block User
                    </Button>
                  </>
                ) : (
                  // Team/Event Channel Actions
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
                )}
              </div>
            </div>
          </TabsContent>
          
          <TabsContent value="members" className="space-y-4 py-4">
            {isLoading ? (
              <div className="py-4 text-center text-gray-500">Loading members...</div>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {members.map((member) => (
                  <div key={member.id} className="flex items-center justify-between p-2 hover:bg-gray-50 rounded">
                    <div className="flex items-center">
                      <div className="w-8 h-8 rounded-full bg-gray-200 mr-3 flex items-center justify-center">
                        {member.image ? (
                          <img src={member.image} alt={member.name} className="w-8 h-8 rounded-full" />
                        ) : (
                          <span>{member.name?.charAt(0) || member.id?.charAt(0) || '?'}</span>
                        )}
                      </div>
                      <div>
                        <div className="font-medium">{member.name || member.id}</div>
                        <div className="text-xs text-gray-500">
                          {member.online ? 'Online' : 'Offline'}
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
  );
};
