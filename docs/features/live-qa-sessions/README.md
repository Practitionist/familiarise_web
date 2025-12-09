# Live Q&A Sessions

## Overview

Public or semi-public live sessions where consultants answer questions from multiple attendees in real-time. Similar to Clarity.fm's "Clarity Live" feature, this enables consultants to reach larger audiences while attendees get value at lower cost.

### Value Proposition

- **Wider Reach**: Consultants engage 10-100+ people at once
- **Lower Cost**: Attendees pay less than 1-on-1 rates
- **Discovery**: New users discover consultants through Q&A
- **Content Creation**: Sessions can be recorded for future content

---

## User Stories

### Consultants

- As a consultant, I want to host live Q&A sessions on topics I specialize in
- As a consultant, I want to moderate questions from attendees
- As a consultant, I want to monetize with ticket sales or keep it free
- As a consultant, I want recordings to share or sell later

### Attendees

- As an attendee, I want to discover upcoming Q&A sessions
- As an attendee, I want to submit questions before and during the session
- As an attendee, I want to see my question answered live
- As an attendee, I want to book 1-on-1 with the consultant after

### Platform

- As the platform, I want to showcase live events for discovery
- As the platform, I want to convert Q&A attendees to paying consultees

---

## Technical Architecture

### Database Schema

**Option A: Extend existing Webinar model**

The existing Webinar model already supports many-to-many relationships. We can extend it for Q&A functionality:

```prisma
model Webinar {
  // Existing fields...

  // NEW: Q&A specific fields
  isQnASession      Boolean @default(false)
  qnaSettings       Json?   // { allowPreQuestions, moderationEnabled, upvotingEnabled }

  questions         LiveQuestion[]
}

model LiveQuestion {
  id              String @id @default(cuid())

  webinar         Webinar @relation(fields: [webinarId], references: [id])
  webinarId       String

  // Who asked
  user            User @relation(fields: [userId], references: [id])
  userId          String
  isAnonymous     Boolean @default(false)

  // Content
  questionText    String @db.Text
  answerText      String? @db.Text     // Written answer (optional)

  // Status
  status          QuestionStatus @default(PENDING)
  answeredAt      DateTime?
  answerStartTime Int?                  // Seconds into recording

  // Engagement
  upvotes         Int @default(0)
  upvotedBy       String[] @default([]) // User IDs

  // Moderation
  isApproved      Boolean @default(true)
  rejectionReason String?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([webinarId])
  @@index([status])
}

enum QuestionStatus {
  PENDING         // Submitted, not yet addressed
  APPROVED        // Approved for answering (if moderation enabled)
  ANSWERED        // Answered during session
  SKIPPED         // Won't be answered
  REJECTED        // Removed by moderator
}
```

**Option B: New LiveSession model (More flexibility)**

```prisma
model LiveSession {
  id              String @id @default(cuid())

  consultantProfile ConsultantProfile @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String

  // Session details
  title           String
  description     String @db.Text
  topic           String?           // Main topic/category

  // Scheduling
  scheduledAt     DateTime
  duration        Int @default(60)  // Minutes
  status          LiveSessionStatus @default(SCHEDULED)

  // Capacity & pricing
  maxAttendees    Int @default(100)
  isFree          Boolean @default(false)
  ticketPrice     Int?              // Price in smallest unit
  currency        String @default("INR")

  // Settings
  settings        Json              // { allowPreQuestions, moderation, upvoting, anonymous }

  // Streaming
  streamUrl       String?           // Live stream URL
  streamKey       String?           // For OBS/streaming software
  recordingUrl    String?           // After session ends

  // Relations
  attendees       LiveSessionAttendee[]
  questions       LiveQuestion[]
  payments        Payment[]

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([consultantProfileId])
  @@index([scheduledAt])
  @@index([status])
}

model LiveSessionAttendee {
  id              String @id @default(cuid())

  session         LiveSession @relation(fields: [sessionId], references: [id])
  sessionId       String

  user            User @relation(fields: [userId], references: [id])
  userId          String

  payment         Payment? @relation(fields: [paymentId], references: [id])
  paymentId       String?

  // Attendance
  registeredAt    DateTime @default(now())
  joinedAt        DateTime?
  leftAt          DateTime?

  // Engagement
  questionsAsked  Int @default(0)
  questionsAnswered Int @default(0)

  @@unique([sessionId, userId])
}

enum LiveSessionStatus {
  DRAFT
  SCHEDULED
  LIVE
  COMPLETED
  CANCELLED
}
```

**Recommendation**: Start with Option A (extending Webinar) for faster implementation. Migrate to Option B if Q&A becomes a core feature.

### Live Session Flow

```
┌─────────────────────────────────────────────────────────┐
│              LIVE Q&A SESSION FLOW                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  PRE-SESSION                                            │
│  ────────────                                           │
│  1. Consultant creates Q&A session                     │
│  2. Users register (free or paid)                      │
│  3. Users submit questions in advance                  │
│  4. Consultant reviews/prioritizes questions           │
│                                                         │
│  DURING SESSION                                         │
│  ──────────────                                         │
│  1. Consultant goes live (video stream)                │
│  2. Attendees join and watch                           │
│  3. Attendees submit new questions in real-time        │
│  4. Attendees upvote questions they want answered      │
│  5. Consultant answers questions (picks from queue)    │
│  6. Questions marked as answered with timestamp        │
│                                                         │
│  POST-SESSION                                           │
│  ────────────                                           │
│  1. Recording saved and processed                      │
│  2. Attendees can access recording                     │
│  3. Unanswered questions can be followed up            │
│  4. Attendees prompted to book 1-on-1                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// lib/live-qa/service.ts

export async function createLiveQASession(
  consultantProfileId: string,
  data: {
    title: string;
    description: string;
    scheduledAt: Date;
    duration: number;
    maxAttendees: number;
    isFree: boolean;
    ticketPrice?: number;
    settings: QASettings;
  },
): Promise<Webinar> {
  const consultantProfile = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    include: { user: true },
  });

  if (!consultantProfile) throw new Error("Consultant not found");

  // Create webinar with Q&A settings
  return prisma.webinar.create({
    data: {
      webinarPlanId: await getOrCreateQAPlan(consultantProfileId, data),
      status: "SCHEDULED",
      isQnASession: true,
      qnaSettings: data.settings,
    },
  });
}

interface QASettings {
  allowPreQuestions: boolean; // Allow questions before session starts
  moderationEnabled: boolean; // Require approval for questions
  upvotingEnabled: boolean; // Allow attendees to upvote
  anonymousEnabled: boolean; // Allow anonymous questions
  maxQuestionsPerUser: number; // Limit per attendee
}

export async function submitQuestion(
  webinarId: string,
  userId: string,
  questionText: string,
  isAnonymous: boolean = false,
): Promise<LiveQuestion> {
  const webinar = await prisma.webinar.findUnique({
    where: { id: webinarId },
    include: { _count: { select: { questions: true } } },
  });

  if (!webinar?.isQnASession) {
    throw new Error("Not a Q&A session");
  }

  const settings = webinar.qnaSettings as QASettings;

  // Check if session allows pre-questions
  if (webinar.status === "SCHEDULED" && !settings.allowPreQuestions) {
    throw new Error("Pre-session questions not allowed");
  }

  // Check user's question limit
  const userQuestionCount = await prisma.liveQuestion.count({
    where: { webinarId, userId },
  });

  if (userQuestionCount >= settings.maxQuestionsPerUser) {
    throw new Error(
      `Maximum ${settings.maxQuestionsPerUser} questions allowed`,
    );
  }

  return prisma.liveQuestion.create({
    data: {
      webinarId,
      userId,
      questionText,
      isAnonymous: settings.anonymousEnabled && isAnonymous,
      status: settings.moderationEnabled ? "PENDING" : "APPROVED",
      isApproved: !settings.moderationEnabled,
    },
  });
}

export async function upvoteQuestion(
  questionId: string,
  userId: string,
): Promise<LiveQuestion> {
  const question = await prisma.liveQuestion.findUnique({
    where: { id: questionId },
    include: { webinar: true },
  });

  if (!question) throw new Error("Question not found");

  const settings = question.webinar.qnaSettings as QASettings;
  if (!settings.upvotingEnabled) {
    throw new Error("Upvoting not enabled");
  }

  // Toggle upvote
  const hasUpvoted = question.upvotedBy.includes(userId);

  return prisma.liveQuestion.update({
    where: { id: questionId },
    data: {
      upvotes: hasUpvoted ? { decrement: 1 } : { increment: 1 },
      upvotedBy: hasUpvoted
        ? question.upvotedBy.filter((id) => id !== userId)
        : [...question.upvotedBy, userId],
    },
  });
}

export async function markQuestionAnswered(
  questionId: string,
  consultantUserId: string,
  answerStartTime?: number, // Seconds into the recording
  answerText?: string,
): Promise<LiveQuestion> {
  const question = await prisma.liveQuestion.findUnique({
    where: { id: questionId },
    include: {
      webinar: {
        include: { webinarPlan: { include: { consultantProfile: true } } },
      },
    },
  });

  if (!question) throw new Error("Question not found");

  // Verify consultant owns this session
  if (
    question.webinar.webinarPlan.consultantProfile.userId !== consultantUserId
  ) {
    throw new Error("Not authorized");
  }

  return prisma.liveQuestion.update({
    where: { id: questionId },
    data: {
      status: "ANSWERED",
      answeredAt: new Date(),
      answerStartTime,
      answerText,
    },
  });
}

export async function getQuestionsQueue(
  webinarId: string,
  sortBy: "upvotes" | "newest" | "oldest" = "upvotes",
): Promise<LiveQuestion[]> {
  const orderBy = {
    upvotes: { upvotes: "desc" as const },
    newest: { createdAt: "desc" as const },
    oldest: { createdAt: "asc" as const },
  }[sortBy];

  return prisma.liveQuestion.findMany({
    where: {
      webinarId,
      status: { in: ["APPROVED", "PENDING"] },
    },
    orderBy,
    include: {
      user: { select: { id: true, name: true, image: true } },
    },
  });
}
```

### API Endpoints

```
// Q&A Sessions
POST /api/live-qa
  Body: { title, description, scheduledAt, ... }
  Creates: New Q&A session

GET /api/live-qa
  Query: ?upcoming=true&consultantId=xxx
  Returns: List of Q&A sessions

GET /api/live-qa/[id]
  Returns: Session details with questions

// Questions
GET /api/live-qa/[id]/questions
  Query: ?sortBy=upvotes|newest
  Returns: Question queue

POST /api/live-qa/[id]/questions
  Body: { questionText, isAnonymous? }
  Creates: New question

POST /api/live-qa/[id]/questions/[questionId]/upvote
  Action: Toggle upvote

PATCH /api/live-qa/[id]/questions/[questionId]/answer
  Body: { answerStartTime?, answerText? }
  Action: Mark as answered (consultant only)

// Moderation
POST /api/live-qa/[id]/questions/[questionId]/approve
POST /api/live-qa/[id]/questions/[questionId]/reject
  Body: { reason? }

// Streaming
GET /api/live-qa/[id]/stream-config
  Returns: { streamUrl, streamKey } (consultant only)

POST /api/live-qa/[id]/go-live
POST /api/live-qa/[id]/end
```

---

## UI/UX Design

### Discover Q&A Sessions

```
┌─────────────────────────────────────────────────────────┐
│  Live Q&A Sessions                                      │
│  Get expert answers at a fraction of the cost          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Upcoming Sessions                                      │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  🔴 LIVE NOW                                        ││
│  │                                                     ││
│  │  Startup Fundraising Q&A                           ││
│  │  with Priya Sharma                                 ││
│  │                                                     ││
│  │  47 attendees | 12 questions answered              ││
│  │                                                     ││
│  │  [Join Now - Free]                                 ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Tomorrow, 3:00 PM                                  ││
│  │                                                     ││
│  │  D2C Growth Masterclass Q&A                        ││
│  │  with Rahul Verma                                  ││
│  │                                                     ││
│  │  ₹199 | 23/50 seats remaining                     ││
│  │                                                     ││
│  │  [Register]  [Submit Question Early]               ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Past Sessions (Recordings)                            │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  Marketing Analytics Deep Dive                      ││
│  │  with Neha Gupta | Dec 5 | 45 min                  ││
│  │  [Watch Recording - ₹99]                           ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Live Session View (Attendee)

```
┌─────────────────────────────────────────────────────────┐
│  Startup Fundraising Q&A                    🔴 LIVE    │
│  with Priya Sharma                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │                                                     ││
│  │              [VIDEO STREAM]                         ││
│  │                                                     ││
│  │              Priya is speaking...                  ││
│  │                                                     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Questions                      [Sort: Top ▼]          │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ ✓ ANSWERED                                         ││
│  │ "What's the ideal amount to raise in a seed round?"││
│  │ Asked by John D. | ▲ 24 upvotes                    ││
│  │ [Jump to answer at 12:34]                          ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 🎯 UP NEXT                                         ││
│  │ "How do I approach VCs without warm intros?"       ││
│  │ Asked by Sarah K. | ▲ 18 upvotes | [Upvote ▲]     ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ "What metrics matter most for Series A?"           ││
│  │ Anonymous | ▲ 12 upvotes | [Upvote ▲]             ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
├─────────────────────────────────────────────────────────┤
│  Ask a Question                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Type your question here...                         ││
│  └─────────────────────────────────────────────────────┘│
│  ☐ Submit anonymously          [Ask Question]         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Consultant Moderation View

```
┌─────────────────────────────────────────────────────────┐
│  Manage Q&A: Startup Fundraising                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  47 attendees | 8 answered | 15 pending                │
│                                                         │
│  [Go Live]  [End Session]                              │
│                                                         │
│  Question Queue                    [Filter: Pending ▼] │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ ▲ 24 | "What's the ideal seed round amount?"       ││
│  │ John D. | 10:23 AM                                  ││
│  │ [Answer Now] [Skip] [Reject]                       ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ ▲ 18 | "How do I approach VCs without intros?"     ││
│  │ Sarah K. | 10:25 AM                                 ││
│  │ [Answer Now] [Skip] [Reject]                       ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Pending Approval (2)                                   │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ "Can you share your email for follow-up?" (SPAM?)  ││
│  │ Anonymous | 10:30 AM                                ││
│  │ [Approve] [Reject]                                  ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Basic Q&A on Webinar

1. Add `isQnASession` and `qnaSettings` to Webinar model
2. Create LiveQuestion model
3. Build question submission and display
4. Integrate with existing webinar flow

### Phase 2: Live Interaction

1. Real-time question updates (WebSocket/Pusher)
2. Upvoting system
3. Moderation queue for consultants
4. Mark questions as answered

### Phase 3: Streaming & Recording

1. Integrate streaming (Mux, LiveKit, or existing Stream)
2. Auto-generate timestamps for answers
3. Post-session recording access
4. Jump-to-answer functionality

### Phase 4: Discovery & Growth

1. Q&A session discovery page
2. Topic-based filtering
3. Notification for upcoming sessions
4. Post-session 1-on-1 upsell

---

## Dependencies

### Depends On

- Existing Webinar/WebinarPlan models
- Video streaming infrastructure
- Real-time communication (Pusher/WebSocket)

### Features That Depend On This

- **Smart Matching** - Recommend Q&A sessions by interest
- **Analytics Dashboard** - Q&A engagement metrics

---

## Monetization Options

1. **Free Sessions**: Build audience, upsell to 1-on-1
2. **Paid Tickets**: ₹99-499 per session
3. **Recording Sales**: Sell past session recordings
4. **Subscription Access**: Q&A included in subscription plans
5. **Priority Questions**: Pay to have question prioritized

---

## Technical Considerations

### Streaming Options

| Option            | Pros                    | Cons                   |
| ----------------- | ----------------------- | ---------------------- |
| Stream (existing) | Already integrated      | May need Q&A extension |
| Mux               | High quality, easy APIs | Additional cost        |
| LiveKit           | Open source, WebRTC     | Self-hosted complexity |
| YouTube Live      | Free, familiar          | Less control           |
| Zoom Webinar      | Feature-rich            | Expensive at scale     |

### Real-Time Updates

- Use existing Pusher setup for question updates
- Channels: `qa-session-{id}` for all attendees
- Events: `new-question`, `question-upvoted`, `question-answered`
