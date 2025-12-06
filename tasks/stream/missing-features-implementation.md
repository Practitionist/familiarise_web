# Missing Features Implementation Guide

This document provides implementation guides for features that are currently placeholder or missing in the chat system.

---

## Table of Contents
1. [Report User](#1-report-user)
2. [Block User](#2-block-user)
3. [Clear Chat](#3-clear-chat)
4. [Delete Chat](#4-delete-chat)
5. [Add Members to Group](#5-add-members-to-group)
6. [Message Reactions](#6-message-reactions)
7. [Typing Indicators](#7-typing-indicators)
8. [Read Receipts](#8-read-receipts)

---

## 1. Report User

### Overview
Allow users to report inappropriate behavior or content from other users.

### Database Schema

Add to `prisma/schema.prisma`:
```prisma
model UserReport {
  id          String   @id @default(cuid())
  reporterId  String
  reportedId  String
  reason      ReportReason
  description String?
  channelId   String?  // Stream channel ID if applicable
  messageId   String?  // Stream message ID if applicable
  status      ReportStatus @default(PENDING)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  resolvedAt  DateTime?
  resolvedBy  String?
  resolution  String?

  reporter    User @relation("ReportsMade", fields: [reporterId], references: [id])
  reported    User @relation("ReportsReceived", fields: [reportedId], references: [id])

  @@index([reporterId])
  @@index([reportedId])
  @@index([status])
}

enum ReportReason {
  HARASSMENT
  SPAM
  INAPPROPRIATE_CONTENT
  IMPERSONATION
  SCAM
  OTHER
}

enum ReportStatus {
  PENDING
  UNDER_REVIEW
  RESOLVED
  DISMISSED
}
```

### API Route

Create `app/api/user/report/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { z } from "zod";

const reportSchema = z.object({
  reportedUserId: z.string(),
  reason: z.enum([
    "HARASSMENT",
    "SPAM",
    "INAPPROPRIATE_CONTENT",
    "IMPERSONATION",
    "SCAM",
    "OTHER",
  ]),
  description: z.string().optional(),
  channelId: z.string().optional(),
  messageId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { reportedUserId, reason, description, channelId, messageId } =
      reportSchema.parse(body);

    // Prevent self-reporting
    if (reportedUserId === session.user.id) {
      return NextResponse.json(
        { error: "Cannot report yourself" },
        { status: 400 }
      );
    }

    // Check if user exists
    const reportedUser = await prisma.user.findUnique({
      where: { id: reportedUserId },
    });

    if (!reportedUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Create report
    const report = await prisma.userReport.create({
      data: {
        reporterId: session.user.id,
        reportedId: reportedUserId,
        reason,
        description,
        channelId,
        messageId,
      },
    });

    // TODO: Send notification to admin/staff

    return NextResponse.json({
      success: true,
      message: "Report submitted successfully",
      reportId: report.id,
    });
  } catch (error) {
    console.error("Error creating report:", error);
    return NextResponse.json(
      { error: "Failed to submit report" },
      { status: 500 }
    );
  }
}
```

### UI Component

Create `components/chat/ReportUserDialog.tsx`:
```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { Loader2 } from "lucide-react";

interface ReportUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  userName: string;
  channelId?: string;
  messageId?: string;
}

const REPORT_REASONS = [
  { value: "HARASSMENT", label: "Harassment or bullying" },
  { value: "SPAM", label: "Spam or advertising" },
  { value: "INAPPROPRIATE_CONTENT", label: "Inappropriate content" },
  { value: "IMPERSONATION", label: "Impersonation" },
  { value: "SCAM", label: "Scam or fraud" },
  { value: "OTHER", label: "Other" },
];

export const ReportUserDialog = ({
  open,
  onOpenChange,
  userId,
  userName,
  channelId,
  messageId,
}: ReportUserDialogProps) => {
  const [reason, setReason] = useState("");
  const [description, setDescription] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async () => {
    if (!reason) {
      toast({
        title: "Error",
        description: "Please select a reason for reporting",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch("/api/user/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportedUserId: userId,
          reason,
          description: description || undefined,
          channelId,
          messageId,
        }),
      });

      const data = await response.json();

      if (response.ok) {
        toast({
          title: "Report submitted",
          description: "Thank you for helping keep our community safe.",
        });
        onOpenChange(false);
        setReason("");
        setDescription("");
      } else {
        throw new Error(data.error);
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to submit report. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Report {userName}</DialogTitle>
          <DialogDescription>
            Help us understand the problem. Reports are confidential.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Reason for reporting</label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {REPORT_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Additional details (optional)
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Provide more context about the issue..."
              rows={4}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Submit Report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
```

---

## 2. Block User

### Overview
Allow users to block other users, preventing them from sending messages.

### Database Schema

Add to `prisma/schema.prisma`:
```prisma
model UserBlock {
  id        String   @id @default(cuid())
  blockerId String
  blockedId String
  createdAt DateTime @default(now())

  blocker   User @relation("BlocksMade", fields: [blockerId], references: [id])
  blocked   User @relation("BlocksReceived", fields: [blockedId], references: [id])

  @@unique([blockerId, blockedId])
  @@index([blockerId])
  @@index([blockedId])
}
```

### API Routes

Create `app/api/user/block/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { StreamChat } from "stream-chat";

const serverClient = StreamChat.getInstance(
  process.env.NEXT_PUBLIC_STREAM_API_KEY!,
  process.env.STREAM_API_SECRET!
);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { blockedUserId } = await req.json();

    if (blockedUserId === session.user.id) {
      return NextResponse.json(
        { error: "Cannot block yourself" },
        { status: 400 }
      );
    }

    // Check if already blocked
    const existingBlock = await prisma.userBlock.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId: session.user.id,
          blockedId: blockedUserId,
        },
      },
    });

    if (existingBlock) {
      return NextResponse.json(
        { error: "User is already blocked" },
        { status: 400 }
      );
    }

    // Create block in database
    await prisma.userBlock.create({
      data: {
        blockerId: session.user.id,
        blockedId: blockedUserId,
      },
    });

    // Block user in Stream Chat
    // This uses Stream's shadow ban feature
    await serverClient.banUser(blockedUserId, {
      banned_by_id: session.user.id,
      shadow: true, // Shadow ban - user can still send but others don't see
    });

    // Find and leave any DM channels with this user
    const channels = await serverClient.queryChannels({
      type: "messaging",
      members: { $eq: [session.user.id, blockedUserId] },
    });

    for (const channel of channels) {
      // Remove the blocked user from seeing new messages
      await channel.addMembers([session.user.id], {
        hide_history: true,
      });
    }

    return NextResponse.json({
      success: true,
      message: "User blocked successfully",
    });
  } catch (error) {
    console.error("Error blocking user:", error);
    return NextResponse.json(
      { error: "Failed to block user" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const blockedUserId = searchParams.get("userId");

    if (!blockedUserId) {
      return NextResponse.json(
        { error: "User ID required" },
        { status: 400 }
      );
    }

    // Remove block from database
    await prisma.userBlock.delete({
      where: {
        blockerId_blockedId: {
          blockerId: session.user.id,
          blockedId: blockedUserId,
        },
      },
    });

    // Unban in Stream
    await serverClient.unbanUser(blockedUserId, {
      unbanned_by_id: session.user.id,
    });

    return NextResponse.json({
      success: true,
      message: "User unblocked successfully",
    });
  } catch (error) {
    console.error("Error unblocking user:", error);
    return NextResponse.json(
      { error: "Failed to unblock user" },
      { status: 500 }
    );
  }
}
```

### Hook for Checking Blocks

Create `hooks/useBlockedUsers.ts`:
```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";

export const useBlockedUsers = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: blockedUsers = [], isLoading } = useQuery({
    queryKey: ["blockedUsers"],
    queryFn: async () => {
      const response = await fetch("/api/user/blocked");
      const data = await response.json();
      return data.blockedUsers || [];
    },
  });

  const blockUser = useMutation({
    mutationFn: async (userId: string) => {
      const response = await fetch("/api/user/block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockedUserId: userId }),
      });
      if (!response.ok) throw new Error("Failed to block user");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blockedUsers"] });
      toast({ title: "User blocked" });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to block user",
        variant: "destructive",
      });
    },
  });

  const unblockUser = useMutation({
    mutationFn: async (userId: string) => {
      const response = await fetch(`/api/user/block?userId=${userId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to unblock user");
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blockedUsers"] });
      toast({ title: "User unblocked" });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to unblock user",
        variant: "destructive",
      });
    },
  });

  const isBlocked = (userId: string) =>
    blockedUsers.some((u: { id: string }) => u.id === userId);

  return {
    blockedUsers,
    isLoading,
    blockUser,
    unblockUser,
    isBlocked,
  };
};
```

---

## 3. Clear Chat

### Overview
Allow users to clear their local chat history without affecting other users.

### Implementation

Update `ChannelInfoAndManageDialog.tsx`:
```typescript
const handleClearChat = async () => {
  if (!client?.userID) return;

  try {
    setIsLoading(true);

    // Truncate the channel (marks all messages as deleted for this user only)
    // This uses Stream's hard delete which removes messages from view
    await channel.truncate({
      hard_delete: false, // Soft delete - keeps for other users
      skip_push: true,
    });

    toast({
      title: "Chat cleared",
      description: "Your chat history has been cleared",
    });
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
```

**Note:** Stream's `truncate` method removes messages. For a true "clear for me only" feature, you'd need to:
1. Track last cleared timestamp per user
2. Filter messages client-side based on this timestamp

### Alternative: Client-side Clear

```typescript
const handleClearChatForMe = async () => {
  // Store the clear timestamp
  localStorage.setItem(
    `chat_cleared_${channel.id}`,
    new Date().toISOString()
  );

  // Force re-render
  window.location.reload();
};

// In message list, filter out old messages
const clearTimestamp = localStorage.getItem(`chat_cleared_${channel.id}`);
const filteredMessages = clearTimestamp
  ? messages.filter(m => new Date(m.created_at) > new Date(clearTimestamp))
  : messages;
```

---

## 4. Delete Chat

### Overview
Delete a DM conversation entirely.

### Implementation

```typescript
const handleDeleteChat = async () => {
  if (!client?.userID || !channel) return;

  // Confirm deletion
  if (!window.confirm("Are you sure you want to delete this chat? This cannot be undone.")) {
    return;
  }

  try {
    setIsLoading(true);

    // For DMs, hide the channel instead of deleting
    // This preserves the channel for the other user
    await channel.hide(client.userID, true); // true = clear history

    // Reset active channel
    setActiveChannel(undefined);

    toast({
      title: "Chat deleted",
      description: "The conversation has been removed",
    });

    setOpen(false);
  } catch (error) {
    console.error("Error deleting chat:", error);
    toast({
      title: "Error",
      description: "Failed to delete chat",
      variant: "destructive",
    });
  } finally {
    setIsLoading(false);
  }
};
```

---

## 5. Add Members to Group

### Overview
Add new members to existing group DMs.

### Implementation

Create `components/chat/AddMembersDialog.tsx`:
```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { useChatContext } from "stream-chat-react";
import { Loader2, Search, UserPlus } from "lucide-react";
import type { Channel, UserResponse } from "stream-chat";

interface AddMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel;
}

export const AddMembersDialog = ({
  open,
  onOpenChange,
  channel,
}: AddMembersDialogProps) => {
  const { client } = useChatContext();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<UserResponse[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isAdding, setIsAdding] = useState(false);

  // Get current member IDs
  const currentMemberIds = Object.keys(channel.state.members || {});

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (!query.trim() || !client) return;

    setIsSearching(true);
    try {
      const response = await client.queryUsers({
        id: { $nin: currentMemberIds }, // Exclude current members
        $or: [
          { name: { $autocomplete: query } },
          { id: { $autocomplete: query } },
        ],
      });
      setSearchResults(response.users);
    } catch (error) {
      console.error("Error searching users:", error);
    } finally {
      setIsSearching(false);
    }
  };

  const toggleUser = (userId: string) => {
    setSelectedUsers((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    );
  };

  const handleAddMembers = async () => {
    if (selectedUsers.length === 0) return;

    setIsAdding(true);
    try {
      await channel.addMembers(selectedUsers);

      toast({
        title: "Members added",
        description: `Added ${selectedUsers.length} member(s) to the group`,
      });

      onOpenChange(false);
      setSelectedUsers([]);
      setSearchResults([]);
      setSearchQuery("");
    } catch (error) {
      console.error("Error adding members:", error);
      toast({
        title: "Error",
        description: "Failed to add members",
        variant: "destructive",
      });
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Members</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              className="pl-10"
            />
          </div>

          {selectedUsers.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selectedUsers.map((userId) => {
                const user = searchResults.find((u) => u.id === userId);
                return (
                  <span
                    key={userId}
                    className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-sm"
                  >
                    {user?.name || userId}
                    <button
                      onClick={() => toggleUser(userId)}
                      className="hover:bg-blue-200 rounded-full p-0.5"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <div className="max-h-60 overflow-y-auto space-y-1">
            {isSearching ? (
              <div className="text-center py-4 text-gray-500">
                Searching...
              </div>
            ) : searchResults.length === 0 && searchQuery ? (
              <div className="text-center py-4 text-gray-500">
                No users found
              </div>
            ) : (
              searchResults.map((user) => (
                <button
                  key={user.id}
                  onClick={() => toggleUser(user.id)}
                  className={`w-full flex items-center gap-3 p-2 rounded hover:bg-gray-100 ${
                    selectedUsers.includes(user.id) ? "bg-blue-50" : ""
                  }`}
                >
                  <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
                    {user.image ? (
                      <img
                        src={user.image}
                        alt=""
                        className="w-8 h-8 rounded-full"
                      />
                    ) : (
                      <span>{(user.name || user.id).charAt(0)}</span>
                    )}
                  </div>
                  <span className="flex-1 text-left">
                    {user.name || user.id}
                  </span>
                  {selectedUsers.includes(user.id) && (
                    <span className="text-blue-600">✓</span>
                  )}
                </button>
              ))
            )}
          </div>

          <Button
            onClick={handleAddMembers}
            disabled={selectedUsers.length === 0 || isAdding}
            className="w-full"
          >
            {isAdding ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <UserPlus className="h-4 w-4 mr-2" />
            )}
            Add {selectedUsers.length || ""} Member
            {selectedUsers.length !== 1 ? "s" : ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
```

---

## 6. Message Reactions

### Overview
Enable emoji reactions on messages.

### Implementation

Stream Chat React SDK has built-in support for reactions. Update the message component:

```typescript
import {
  MessageSimple,
  ReactionSelector,
  ReactionsList,
  useMessageContext,
} from "stream-chat-react";

export const CustomMessage = () => {
  const { message } = useMessageContext();

  return (
    <div className="relative group">
      <MessageSimple />

      {/* Reaction button appears on hover */}
      <div className="absolute -top-6 right-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <ReactionSelector />
      </div>

      {/* Show existing reactions */}
      {message.reaction_counts && (
        <ReactionsList reactions={message.reaction_counts} />
      )}
    </div>
  );
};
```

Enable in Chat configuration:
```typescript
<Channel
  ReactionsList={CustomReactionsList}
  ReactionSelector={CustomReactionSelector}
  // ... other props
>
```

---

## 7. Typing Indicators

### Overview
Show when other users are typing.

### Implementation

Stream Chat React SDK includes built-in typing indicators:

```typescript
import { TypingIndicator } from "stream-chat-react";

// In your chat container/message list:
<div className="chat-container">
  <MessageList />
  <TypingIndicator />
  <MessageInput />
</div>
```

The SDK automatically handles sending typing events when users type.

---

## 8. Read Receipts

### Overview
Show read status for messages.

### Implementation

Stream tracks read state automatically. Display it in messages:

```typescript
import { useChannelStateContext, useMessageContext } from "stream-chat-react";

const ReadStatus = () => {
  const { message } = useMessageContext();
  const { read } = useChannelStateContext();

  if (!message || !read) return null;

  // Get users who have read this message
  const readers = Object.entries(read)
    .filter(([userId, readState]) => {
      if (userId === message.user?.id) return false; // Exclude sender
      return new Date(readState.last_read) >= new Date(message.created_at);
    })
    .map(([userId]) => userId);

  if (readers.length === 0) {
    return <span className="text-gray-400">✓</span>; // Sent
  }

  return (
    <span className="text-blue-500" title={`Read by ${readers.join(", ")}`}>
      ✓✓
    </span>
  );
};

// Use in custom message component
export const CustomMessage = () => {
  const { message, isMyMessage } = useMessageContext();

  return (
    <div className="message">
      <MessageSimple />
      {isMyMessage() && <ReadStatus />}
    </div>
  );
};
```

---

## Summary

| Feature | Effort | Priority | Dependencies |
|---------|--------|----------|--------------|
| Report User | Medium | High | Database schema, API, UI |
| Block User | Medium | High | Database schema, API, Stream integration |
| Clear Chat | Low | Medium | Client-side only |
| Delete Chat | Low | Medium | Stream API |
| Add Members | Medium | Medium | UI component |
| Message Reactions | Low | Low | Stream built-in |
| Typing Indicators | Low | Low | Stream built-in |
| Read Receipts | Low | Low | Stream built-in |

## Recommended Implementation Order

1. **Phase 1 (Essential):** Report User, Block User
2. **Phase 2 (Important):** Add Members, Clear Chat, Delete Chat
3. **Phase 3 (Nice to have):** Typing Indicators, Read Receipts, Message Reactions
