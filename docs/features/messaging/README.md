# In-App Messaging

## Overview

A secure messaging system that allows consultees and consultants to communicate before, during, and after consultations. Enables pre-session coordination, follow-up questions, and async consultation support.

### Value Proposition

- **Pre-Session Context**: Share background info before meetings
- **Follow-Up Support**: Continue conversations after sessions
- **Async Options**: Not everything needs a video call
- **Platform Stickiness**: Keep communication within the platform

---

## User Stories

### Consultees

- As a consultee, I want to message a consultant before booking to clarify fit
- As a consultee, I want to send follow-up questions after a session
- As a consultee, I want to share documents/links via message
- As a consultee, I want to see message history with each consultant

### Consultants

- As a consultant, I want to respond to prospective client questions
- As a consultant, I want to set availability for async messaging
- As a consultant, I want to turn messaging on/off per plan
- As a consultant, I want to manage message notifications

---

## Technical Architecture

### Database Schema

**New models required:**

```prisma
model Conversation {
  id                String @id @default(cuid())

  // Participants
  consultantProfile ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String
  consulteeProfile  ConsulteeProfile @relation(fields: [consulteeProfileId], references: [id])
  consulteeProfileId String

  // Context (optional - linked to specific booking)
  appointmentId     String?
  consultationPlanId String?

  // Status
  status            ConversationStatus @default(ACTIVE)
  lastMessageAt     DateTime?

  // Read tracking
  consultantLastReadAt DateTime?
  consulteeLastReadAt  DateTime?

  messages          Message[]

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([consultantProfileId, consulteeProfileId])
  @@index([consultantProfileId])
  @@index([consulteeProfileId])
  @@index([lastMessageAt])
}

model Message {
  id              String @id @default(cuid())

  conversation    Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  conversationId  String

  // Sender
  senderId        String           // User ID
  senderType      ParticipantType  // CONSULTANT or CONSULTEE

  // Content
  content         String @db.Text
  contentType     MessageContentType @default(TEXT)

  // Attachments
  attachments     MessageAttachment[]

  // Status
  isRead          Boolean @default(false)
  readAt          DateTime?
  isEdited        Boolean @default(false)
  editedAt        DateTime?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([conversationId])
  @@index([senderId])
  @@index([createdAt])
}

model MessageAttachment {
  id              String @id @default(cuid())
  message         Message @relation(fields: [messageId], references: [id], onDelete: Cascade)
  messageId       String
  fileName        String
  fileUrl         String
  fileSize        Int
  mimeType        String
  createdAt       DateTime @default(now())
}

enum ConversationStatus {
  ACTIVE
  ARCHIVED
  BLOCKED
}

enum ParticipantType {
  CONSULTANT
  CONSULTEE
}

enum MessageContentType {
  TEXT
  SYSTEM          // "Consultation scheduled", "Session completed"
  BOOKING_REQUEST // Inline booking prompt
}
```

### Real-Time Architecture

```
┌─────────────────────────────────────────────────────────┐
│              MESSAGING ARCHITECTURE                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Option A: Polling (Simple)                             │
│  ─────────────────────────                              │
│  Client polls /api/messages every 5-10 seconds          │
│  + Simple to implement                                  │
│  - Not truly real-time, battery drain on mobile        │
│                                                         │
│  Option B: WebSocket (Recommended)                      │
│  ─────────────────────────────────                      │
│  ┌────────────┐     ┌─────────────┐     ┌────────────┐ │
│  │   Client   │────▶│  WebSocket  │────▶│   Client   │ │
│  │  (Sender)  │     │   Server    │     │ (Receiver) │ │
│  └────────────┘     └─────────────┘     └────────────┘ │
│                           │                             │
│                           ▼                             │
│                    ┌─────────────┐                      │
│                    │  Database   │                      │
│                    │ (Postgres)  │                      │
│                    └─────────────┘                      │
│                                                         │
│  Option C: Pusher/Ably (Managed)                       │
│  ─────────────────────────────────                      │
│  Third-party WebSocket service                         │
│  + Easy to scale, managed infrastructure               │
│  - Additional cost                                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// lib/messaging/service.ts

export async function getOrCreateConversation(
  consultantProfileId: string,
  consulteeProfileId: string
): Promise<Conversation> {
  let conversation = await prisma.conversation.findUnique({
    where: {
      consultantProfileId_consulteeProfileId: {
        consultantProfileId,
        consulteeProfileId,
      },
    },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        consultantProfileId,
        consulteeProfileId,
        status: 'ACTIVE',
      },
    });
  }

  return conversation;
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  senderType: ParticipantType,
  content: string,
  attachments?: { fileName: string; fileUrl: string; fileSize: number; mimeType: string }[]
): Promise<Message> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      consultantProfile: { include: { user: true } },
      consulteeProfile: { include: { user: true } },
    },
  });

  if (!conversation || conversation.status !== 'ACTIVE') {
    throw new Error('Conversation not found or inactive');
  }

  // Validate sender is participant
  const isConsultant = conversation.consultantProfile.userId === senderId;
  const isConsultee = conversation.consulteeProfile.userId === senderId;

  if (!isConsultant && !isConsultee) {
    throw new Error('Not authorized to send messages in this conversation');
  }

  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId,
      senderType,
      content,
      contentType: 'TEXT',
      attachments: attachments ? {
        create: attachments,
      } : undefined,
    },
    include: { attachments: true },
  });

  // Update conversation
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });

  // Send real-time notification
  await notifyNewMessage(conversation, message);

  // Send push/email if recipient offline
  const recipientUserId = isConsultant
    ? conversation.consulteeProfile.userId
    : conversation.consultantProfile.userId;

  await queueMessageNotification(recipientUserId, message);

  return message;
}

async function notifyNewMessage(conversation: Conversation, message: Message): Promise<void> {
  // Using Pusher
  const pusher = new Pusher({
    appId: process.env.PUSHER_APP_ID!,
    key: process.env.PUSHER_KEY!,
    secret: process.env.PUSHER_SECRET!,
    cluster: process.env.PUSHER_CLUSTER!,
  });

  await pusher.trigger(`conversation-${conversation.id}`, 'new-message', {
    message: {
      id: message.id,
      senderId: message.senderId,
      senderType: message.senderType,
      content: message.content,
      createdAt: message.createdAt,
    },
  });
}

export async function markAsRead(
  conversationId: string,
  userId: string
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      consultantProfile: true,
      consulteeProfile: true,
    },
  });

  if (!conversation) return;

  const isConsultant = conversation.consultantProfile.userId === userId;
  const isConsultee = conversation.consulteeProfile.userId === userId;

  if (!isConsultant && !isConsultee) return;

  // Update conversation read timestamp
  await prisma.conversation.update({
    where: { id: conversationId },
    data: isConsultant
      ? { consultantLastReadAt: new Date() }
      : { consulteeLastReadAt: new Date() },
  });

  // Mark individual messages as read
  await prisma.message.updateMany({
    where: {
      conversationId,
      senderId: { not: userId },
      isRead: false,
    },
    data: {
      isRead: true,
      readAt: new Date(),
    },
  });
}

export async function getUnreadCount(userId: string): Promise<number> {
  // Get user's profile IDs
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      consultantProfile: true,
      consulteeProfile: true,
    },
  });

  const conditions = [];

  if (user?.consultantProfile) {
    conditions.push({
      consultantProfileId: user.consultantProfile.id,
      messages: {
        some: {
          senderType: 'CONSULTEE',
          isRead: false,
        },
      },
    });
  }

  if (user?.consulteeProfile) {
    conditions.push({
      consulteeProfileId: user.consulteeProfile.id,
      messages: {
        some: {
          senderType: 'CONSULTANT',
          isRead: false,
        },
      },
    });
  }

  if (conditions.length === 0) return 0;

  const count = await prisma.message.count({
    where: {
      conversation: { OR: conditions },
      senderId: { not: userId },
      isRead: false,
    },
  });

  return count;
}
```

### API Endpoints

```
// Conversations
GET /api/conversations
  Returns: User's conversations with preview

GET /api/conversations/[id]
  Returns: Conversation details with participants

POST /api/conversations
  Body: { consultantProfileId } OR { consulteeProfileId }
  Creates: New conversation

// Messages
GET /api/conversations/[id]/messages
  Query: ?limit=50&before=messageId
  Returns: Paginated messages

POST /api/conversations/[id]/messages
  Body: { content, attachments? }
  Creates: New message

PATCH /api/conversations/[id]/messages/[messageId]
  Body: { content }
  Updates: Edit message (within time limit)

DELETE /api/conversations/[id]/messages/[messageId]
  Deletes: Soft delete message

// Read status
POST /api/conversations/[id]/read
  Action: Mark conversation as read

GET /api/messages/unread-count
  Returns: { count: number }
```

---

## UI/UX Design

### Messages List (`/dashboard/messages`)

```
┌─────────────────────────────────────────────────────────┐
│  Messages                                      🔍 Search │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ ● Priya Sharma                           2 min ago ││
│  │   Thanks for the follow-up questions! I'll...      ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │   Rahul Verma                          Yesterday   ││
│  │   Looking forward to our session tomorrow!         ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │   Neha Gupta                             Dec 5     ││
│  │   Great session! Let me know if you have...       ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘

● = Unread messages
```

### Conversation View

```
┌─────────────────────────────────────────────────────────┐
│  ← Back    Priya Sharma    [View Profile] [Book Session]│
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │                   December 9, 2024                  ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│        ┌─────────────────────────────────────┐         │
│        │ Hi Priya! I had a great session    │ 10:30 AM│
│        │ yesterday. Quick follow-up: what   │    You  │
│        │ tools do you recommend for CAC      │         │
│        │ tracking?                           │         │
│        └─────────────────────────────────────┘         │
│                                                         │
│  ┌─────────────────────────────────────────┐           │
│  │ Great question! I recommend:            │ 10:45 AM │
│  │                                         │   Priya  │
│  │ 1. Mixpanel for funnel analytics       │          │
│  │ 2. Triple Whale for ad attribution     │          │
│  │ 3. A simple spreadsheet for weekly     │          │
│  │    CAC calculations                     │          │
│  │                                         │          │
│  │ Want me to share a template?           │          │
│  └─────────────────────────────────────────┘           │
│                                                         │
│        ┌─────────────────────────────────────┐         │
│        │ Yes please! That would be super    │ 10:47 AM│
│        │ helpful. 🙏                         │    You  │
│        └─────────────────────────────────────┘         │
│                                                         │
│  ┌─────────────────────────────────────────┐           │
│  │ 📎 CAC_Tracking_Template.xlsx          │ 10:52 AM │
│  │    (42 KB) [Download]                   │   Priya  │
│  │                                         │          │
│  │ Here you go! Let me know if you need   │          │
│  │ help setting it up.                     │          │
│  └─────────────────────────────────────────┘           │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐│
│  │ Type a message...                        📎  [Send]││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Message from Profile (Pre-Booking)

```
┌─────────────────────────────────────────────────────────┐
│  Priya Sharma                                           │
│  Marketing Strategist | ⭐ 4.9                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Have a question before booking?                       │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Ask Priya a question...                            ││
│  │                                                     ││
│  │                                                     ││
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  [Send Message]                                         │
│                                                         │
│  Typically responds within 2 hours                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Basic Messaging

1. Create Conversation and Message models
2. Basic send/receive APIs
3. Simple messages list UI
4. Conversation view

### Phase 2: Real-Time

1. Integrate Pusher or WebSocket
2. Real-time message delivery
3. Typing indicators
4. Online status

### Phase 3: Features

1. File attachments
2. Read receipts
3. Message search
4. Notifications (push/email for offline)

### Phase 4: Advanced

1. Message editing/deletion
2. Conversation archiving/blocking
3. System messages (booking confirmations)
4. Rich media preview (links, images)

---

## Dependencies

### Depends On

- ConsultantProfile, ConsulteeProfile models
- Notification system
- File storage (for attachments)

### Features That Depend On This

- **Gift Consultations** - Messaging can include gift context
- **Waitlist** - Notify via message when slot opens

---

## Security & Privacy

- Messages encrypted in transit (HTTPS)
- Consider end-to-end encryption for sensitive conversations
- Rate limiting on message sending
- Spam/abuse reporting
- Message retention policy
- GDPR: Export and delete message history

---

## Consultant Settings

```typescript
// Allow consultants to control messaging
interface MessagingSettings {
  messagingEnabled: boolean;          // Allow messages at all
  allowPreBookingMessages: boolean;   // Before any booking
  allowPostSessionMessages: boolean;  // After session ends
  postSessionMessageDays: number;     // How long after session
  autoResponseEnabled: boolean;
  autoResponseMessage: string;        // "Thanks for reaching out..."
}
```
