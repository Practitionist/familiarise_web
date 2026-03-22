"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { format } from "date-fns";
import { useState, useRef, useEffect } from "react";
import {
  Attachment,
  useChatContext,
  useMessageContext,
  useMessageComposer,
} from "stream-chat-react";
import {
  SmileIcon,
  ReplyIcon,
  MoreHorizontalIcon,
  EditIcon,
  Trash2Icon,
  CheckIcon,
  XIcon,
  FlagIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export const CustomMessage = () => {
  const { message } = useMessageContext();
  const { client, channel } = useChatContext();
  const messageComposer = useMessageComposer();
  const { toast } = useToast();
  const isMyMessage = message.user?.id === client.userID;
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(message.text || "");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Refs for click-outside detection
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const moreOptionsRef = useRef<HTMLDivElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(event.target as Node)
      ) {
        setShowEmojiPicker(false);
      }
      if (
        moreOptionsRef.current &&
        !moreOptionsRef.current.contains(event.target as Node)
      ) {
        setShowMoreOptions(false);
      }
    };

    if (showEmojiPicker || showMoreOptions) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showEmojiPicker, showMoreOptions]);

  // Map Stream reaction types to actual emoji characters
  const reactionTypeToEmoji: Record<string, string> = {
    like: "👍",
    love: "❤️",
    haha: "😂",
    wow: "😮",
    sad: "😢",
    angry: "😠",
    "thumbs-up": "👍",
    "thumbs-down": "👎",
    heart: "❤️",
    fire: "🔥",
    clap: "👏",
    "100": "💯",
    celebrate: "🎉",
    rocket: "🚀",
    eyes: "👀",
    thinking: "🤔",
    plus_one: "👍",
    smile: "😄",
  };

  // Quick reactions for the picker
  const quickReactions = [
    "like",
    "love",
    "haha",
    "wow",
    "sad",
    "angry",
    "fire",
    "clap",
  ];

  // Check if the message has text content
  const hasText = !!message.text?.trim();
  // Check if the message has attachments
  const hasAttachments =
    !!message.attachments && message.attachments.length > 0;

  // Check if message is deleted
  const isDeleted = message.deleted_at != null;

  // Check if this message is a reply to another message
  const hasQuotedMessage = !!message.quoted_message;

  // Avoid rendering empty messages
  if (!hasText && !hasAttachments && message.type !== "system" && !isDeleted) {
    return null;
  }

  // Show deleted message placeholder
  if (isDeleted) {
    return (
      <div
        className={`flex items-end ${isMyMessage ? "justify-end" : "justify-start"} mb-4`}
      >
        <div className="italic text-gray-400 text-sm px-3 py-2">
          This message was deleted
        </div>
      </div>
    );
  }

  const handleEditClick = () => {
    setIsEditing(true);
    setEditText(message.text || "");
    setShowMoreOptions(false);
  };

  const handleEditSave = async () => {
    if (!client || !editText.trim()) return;
    try {
      await client.updateMessage({
        id: message.id,
        text: editText,
      });
      setIsEditing(false);
    } catch (error) {
      console.error("Error editing message:", error);
      toast({
        title: "Edit failed",
        description: "Could not edit the message. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleEditCancel = () => {
    setIsEditing(false);
    setEditText(message.text || "");
  };

  const handleDeleteClick = () => {
    setShowDeleteDialog(true);
    setShowMoreOptions(false);
  };

  const handleDeleteConfirm = async () => {
    if (!client) return;
    try {
      await client.deleteMessage(message.id);
    } catch (error) {
      console.error("Error deleting message:", error);
      toast({
        title: "Delete failed",
        description: "Could not delete the message. Please try again.",
        variant: "destructive",
      });
    }
    setShowDeleteDialog(false);
  };

  const handleReactionClick = async (reactionType: string) => {
    if (!channel) return;
    try {
      await channel.sendReaction(message.id, { type: reactionType });
    } catch (error) {
      console.error("Error sending reaction:", error);
      toast({
        title: "Reaction failed",
        description: "Could not add reaction. Please try again.",
        variant: "destructive",
      });
    }
  };

  // WhatsApp/Telegram style reply - sets the message as quoted for the input
  const handleReplyClick = () => {
    // Use Stream Chat v13's MessageComposer API to set quoted message
    messageComposer.setQuotedMessage(message);
  };

  // Report a message (flags in Stream + persists to DB)
  const handleReportMessage = async () => {
    if (!channel || !message.user?.id) return;
    try {
      // Flag in Stream
      await channel.flagMessage(message.id);

      // Persist to our DB
      await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "MESSAGE",
          reason: "Reported message",
          targetUserId: message.user.id,
          contentText: message.text?.substring(0, 500),
        }),
      });

      toast({
        title: "Message reported",
        description: "Our team will review this message",
      });
    } catch (error) {
      console.error("Error reporting message:", error);
      toast({
        title: "Report failed",
        description: "Could not report message. Please try again.",
        variant: "destructive",
      });
    }
    setShowMoreOptions(false);
  };

  return (
    <div
      className={`flex items-end ${isMyMessage ? "justify-end" : "justify-start"} mb-4 group relative`}
    >
      {/* Avatar for other users' messages */}
      {!isMyMessage && (
        <Avatar className="mr-2 w-8 h-8 flex-shrink-0">
          <AvatarImage src={message.user?.image} />
          <AvatarFallback>
            {message.user?.name?.charAt(0) ??
              message.user?.id?.charAt(0) ??
              "?"}
          </AvatarFallback>
        </Avatar>
      )}

      {/* Message wrapper with hover actions */}
      <div className="relative max-w-[85%]">
        {/* Action Toolbar - appears on hover */}
        <div
          className={`absolute ${isMyMessage ? "right-0" : "left-0"} bottom-full mb-1 opacity-0 group-hover:opacity-100 transition-opacity z-20`}
        >
          <div className="flex items-center gap-0.5 bg-white rounded-lg shadow-lg border">
            {/* React with Emoji */}
            <div className="relative" ref={emojiPickerRef}>
              <button
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                className="p-1.5 hover:bg-gray-100 rounded-l-lg transition-colors"
                title="React"
              >
                <SmileIcon className="w-4 h-4 text-gray-600" />
              </button>
              {/* Custom Emoji Picker Dropdown - positioned right for user's messages */}
              {showEmojiPicker && (
                <div
                  className={`absolute top-full mt-1 z-30 bg-white rounded-lg shadow-lg border p-2 ${isMyMessage ? "right-0" : "left-0"}`}
                >
                  <div className="flex gap-1">
                    {quickReactions.map((reactionType) => (
                      <button
                        key={reactionType}
                        onClick={() => {
                          handleReactionClick(reactionType);
                          setShowEmojiPicker(false);
                        }}
                        className="text-xl hover:bg-gray-100 rounded p-1 transition-colors"
                        title={reactionType}
                      >
                        {reactionTypeToEmoji[reactionType]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Reply (WhatsApp/Telegram style) */}
            <button
              onClick={handleReplyClick}
              className="p-1.5 hover:bg-gray-100 transition-colors"
              title="Reply"
            >
              <ReplyIcon className="w-4 h-4 text-gray-600" />
            </button>

            {/* More Options (Edit, Delete for own; Report for others) */}
            <div className="relative" ref={moreOptionsRef}>
              <button
                onClick={() => setShowMoreOptions(!showMoreOptions)}
                className="p-1.5 hover:bg-gray-100 rounded-r-lg transition-colors"
                title="More options"
              >
                <MoreHorizontalIcon className="w-4 h-4 text-gray-600" />
              </button>
              {/* More Options Dropdown */}
              {showMoreOptions && (
                <div className="absolute top-full right-0 mt-1 bg-white rounded-lg shadow-lg border py-1 min-w-[120px] z-30">
                  {isMyMessage ? (
                    <>
                      <button
                        onClick={handleEditClick}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
                      >
                        <EditIcon className="w-4 h-4" />
                        Edit
                      </button>
                      <button
                        onClick={handleDeleteClick}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 text-red-600 flex items-center gap-2"
                      >
                        <Trash2Icon className="w-4 h-4" />
                        Delete
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={handleReportMessage}
                      className="w-full px-3 py-1.5 text-left text-sm hover:bg-gray-100 text-red-600 flex items-center gap-2"
                    >
                      <FlagIcon className="w-4 h-4" />
                      Report Message
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Message Bubble */}
        <div
          className={`${isMyMessage ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-800"} rounded-lg px-3 py-2`}
        >
          {/* Quoted/Replied Message (WhatsApp/Telegram style) */}
          {hasQuotedMessage && message.quoted_message && (
            <div
              className={`mb-2 p-2 rounded-md border-l-4 ${
                isMyMessage
                  ? "bg-blue-600/40 border-blue-300"
                  : "bg-gray-300/60 border-gray-500"
              }`}
            >
              <div
                className={`text-xs font-semibold mb-0.5 ${isMyMessage ? "text-blue-100" : "text-gray-700"}`}
              >
                {message.quoted_message.user?.name ||
                  message.quoted_message.user?.id ||
                  "Unknown"}
              </div>
              <div
                className={`text-xs truncate max-w-[250px] ${isMyMessage ? "text-blue-100/80" : "text-gray-600"}`}
              >
                {message.quoted_message.text || "[Attachment]"}
              </div>
            </div>
          )}

          {/* User Name for other users' messages */}
          {!isMyMessage && !hasQuotedMessage && (
            <div className="font-semibold text-sm mb-1">
              {message.user?.name ?? message.user?.id}
            </div>
          )}

          {/* Render Attachments if they exist */}
          {hasAttachments && (
            <div className={`attachments ${hasText ? "mb-1" : ""} grid gap-2`}>
              {message.attachments?.map((attachment, index) => (
                <div
                  key={`${message.id}-attachment-${index}`}
                  className="attachment-item"
                >
                  <Attachment attachments={[attachment]} />
                </div>
              ))}
            </div>
          )}

          {/* Render Text - show input if editing, otherwise show text */}
          {isEditing ? (
            <div className="flex flex-col gap-2">
              <Input
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className={`w-full min-w-[200px] ${isMyMessage ? "bg-blue-400 text-white placeholder-blue-200 border-blue-300" : "bg-white text-gray-800"}`}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleEditSave();
                  }
                  if (e.key === "Escape") {
                    handleEditCancel();
                  }
                }}
              />
              <div className="flex gap-1 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleEditCancel}
                  className={`h-6 px-2 ${isMyMessage ? "text-blue-100 hover:bg-blue-400" : "text-gray-600 hover:bg-gray-200"}`}
                >
                  <XIcon className="w-3 h-3 mr-1" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleEditSave}
                  className={`h-6 px-2 ${isMyMessage ? "bg-blue-300 text-blue-900 hover:bg-blue-200" : "bg-blue-500 text-white hover:bg-blue-600"}`}
                >
                  <CheckIcon className="w-3 h-3 mr-1" />
                  Save
                </Button>
              </div>
            </div>
          ) : (
            hasText && (
              <div className="message-text break-words">{message.text}</div>
            )
          )}

          {/* Reactions display */}
          {message.reaction_counts &&
            Object.keys(message.reaction_counts).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {Object.entries(message.reaction_counts).map(
                  ([reactionType, count]) => {
                    const emoji =
                      reactionTypeToEmoji[reactionType] || reactionType;
                    return (
                      <span
                        key={reactionType}
                        className={`text-sm px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 ${
                          isMyMessage ? "bg-blue-400/50" : "bg-gray-200"
                        }`}
                        onClick={() => handleReactionClick(reactionType)}
                        title={`${reactionType} (click to react)`}
                      >
                        {emoji} {count}
                      </span>
                    );
                  },
                )}
              </div>
            )}

          {/* Timestamp */}
          <div
            className={`text-xs mt-1 text-right ${isMyMessage ? "text-blue-100 opacity-80" : "text-gray-500"} opacity-0 group-hover:opacity-100 transition-opacity`}
          >
            {message.created_at && format(new Date(message.created_at), "p")}
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Message</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this message? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Yes, Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
