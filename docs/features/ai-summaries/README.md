# AI Meeting Summaries

## Overview

Automatically generate summaries, key takeaways, and action items from consultation recordings using AI. Helps consultees retain value and gives consultants insights into common discussion topics.

### Value Proposition

- **Value Retention**: Consultees remember key points from sessions
- **Time Savings**: No manual note-taking required
- **Searchable History**: Find past discussions easily
- **Consultant Insights**: Understand common client questions

---

## User Stories

### Consultees

- As a consultee, I want an automatic summary after my consultation
- As a consultee, I want to see action items from our discussion
- As a consultee, I want to search my past session summaries
- As a consultee, I want to share summaries with my team

### Consultants

- As a consultant, I want to review summaries before follow-up calls
- As a consultant, I want to see common topics across all clients
- As a consultant, I want to add notes to AI-generated summaries
- As a consultant, I want to disable summaries for sensitive sessions

---

## Technical Architecture

### Database Schema

**No new models required.** Store summaries in existing models:

```prisma
// Use existing Recording model
model Recording {
  id              String   @id @default(cuid())
  title           String?
  recordingUrl    String
  duration        Int?
  recordedAt      DateTime?

  // ADD: AI summary fields
  transcription   String?  @db.Text    // Full transcript
  summary         Json?                 // Structured summary
  processedAt     DateTime?             // When AI processing completed

  meetingSession  MeetingSession @relation(...)
}

// Summary JSON structure
interface SessionSummary {
  overview: string;           // 2-3 sentence summary
  keyTopics: {
    topic: string;
    details: string;
  }[];
  actionItems: {
    item: string;
    assignee: 'consultant' | 'consultee' | 'both';
    dueDate?: string;
  }[];
  questions: string[];        // Questions discussed
  recommendations: string[];  // Consultant's advice
  followUp: {
    suggested: boolean;
    reason?: string;
  };
  sentiment: 'positive' | 'neutral' | 'mixed';
  duration: number;           // Minutes
  generatedAt: string;        // ISO timestamp
}
```

### AI Processing Pipeline

```
┌─────────────────────────────────────────────────────────┐
│              AI SUMMARY PIPELINE                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. RECORDING COMPLETE                                  │
│     ─────────────────────                               │
│     - Meeting ends, recording saved                     │
│     - Webhook/event triggered                           │
│                                                         │
│  2. TRANSCRIPTION                                       │
│     ─────────────                                       │
│     - Download audio from Stream/Zoom                   │
│     - Send to Whisper API / Deepgram / AssemblyAI      │
│     - Store transcript with speaker labels              │
│                                                         │
│  3. SUMMARY GENERATION                                  │
│     ───────────────────                                 │
│     - Send transcript to GPT-4 / Claude                │
│     - Structured prompt for consistent output          │
│     - Extract topics, actions, recommendations         │
│                                                         │
│  4. STORAGE & NOTIFICATION                              │
│     ──────────────────────                              │
│     - Store summary in Recording.summary               │
│     - Notify consultee via email                       │
│     - Make available in dashboard                      │
│                                                         │
│  Timeline: ~5-15 minutes after meeting ends            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```typescript
// lib/ai/summaries.ts

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

const openai = new OpenAI();
const anthropic = new Anthropic();

interface TranscriptSegment {
  speaker: "consultant" | "consultee";
  text: string;
  timestamp: number;
}

export async function transcribeRecording(
  recordingUrl: string,
): Promise<string> {
  // Option 1: OpenAI Whisper
  const response = await openai.audio.transcriptions.create({
    file: await fetchAsFile(recordingUrl),
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  return response.text;

  // Option 2: Deepgram (better for speaker diarization)
  // const deepgram = new Deepgram(process.env.DEEPGRAM_API_KEY);
  // const response = await deepgram.transcription.preRecorded(
  //   { url: recordingUrl },
  //   { punctuate: true, diarize: true, utterances: true }
  // );
  // return response.results.utterances;
}

export async function generateSummary(
  transcript: string,
  context: {
    consultantName: string;
    consulteeName: string;
    appointmentType: string;
    planName: string;
  },
): Promise<SessionSummary> {
  const systemPrompt = `You are an expert at summarizing professional consultation sessions.
Generate a structured summary of the following consultation between ${context.consultantName} (consultant) and ${context.consulteeName} (client).

Context: This was a ${context.appointmentType} session for "${context.planName}".

Provide your response as JSON with the following structure:
{
  "overview": "2-3 sentence summary of the session",
  "keyTopics": [{ "topic": "string", "details": "string" }],
  "actionItems": [{ "item": "string", "assignee": "consultant|consultee|both", "dueDate": "optional string" }],
  "questions": ["Questions the client asked"],
  "recommendations": ["Advice given by consultant"],
  "followUp": { "suggested": boolean, "reason": "optional string" },
  "sentiment": "positive|neutral|mixed"
}`;

  const response = await anthropic.messages.create({
    model: "claude-3-sonnet-20240229",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: `${systemPrompt}\n\nTranscript:\n${transcript}`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type === "text") {
    return JSON.parse(content.text);
  }

  throw new Error("Failed to generate summary");
}

// Background job handler
export async function processRecordingSummary(
  recordingId: string,
): Promise<void> {
  const recording = await prisma.recording.findUnique({
    where: { id: recordingId },
    include: {
      meetingSession: {
        include: {
          slotOfAppointment: {
            include: {
              appointment: {
                include: {
                  consultation: {
                    include: {
                      consultationPlan: {
                        include: {
                          consultantProfile: { include: { user: true } },
                        },
                      },
                      consulteeProfile: { include: { user: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!recording || recording.processedAt) return;

  try {
    // 1. Transcribe
    const transcript = await transcribeRecording(recording.recordingUrl);

    // 2. Generate summary
    const consultation =
      recording.meetingSession.slotOfAppointment?.appointment?.consultation;
    const summary = await generateSummary(transcript, {
      consultantName:
        consultation?.consultationPlan.consultantProfile.user.name ||
        "Consultant",
      consulteeName: consultation?.consulteeProfile.user.name || "Client",
      appointmentType: "Consultation",
      planName: consultation?.consultationPlan.title || "Session",
    });

    // 3. Store results
    await prisma.recording.update({
      where: { id: recordingId },
      data: {
        transcription: transcript,
        summary: summary as any,
        processedAt: new Date(),
      },
    });

    // 4. Notify consultee
    const consulteeUserId = consultation?.consulteeProfile.user.id;
    if (consulteeUserId) {
      await sendNotification(consulteeUserId, "SESSION_SUMMARY_READY", {
        consultantName:
          consultation?.consultationPlan.consultantProfile.user.name,
        summaryUrl: `/dashboard/appointments/${recording.meetingSession.slotOfAppointment?.appointmentId}/summary`,
      });
    }
  } catch (error) {
    console.error("Summary processing failed:", error);
    // Queue for retry
  }
}
```

### API Endpoints

```
GET /api/appointments/[id]/summary
  Returns: Session summary with transcript access
  Auth: Consultant or consultee of the appointment

GET /api/appointments/[id]/transcript
  Returns: Full transcript with timestamps
  Auth: Consultant or consultee

PATCH /api/appointments/[id]/summary
  Body: { consultantNotes, actionItemsUpdate }
  Action: Consultant adds notes to summary
  Auth: Consultant only

POST /api/appointments/[id]/summary/regenerate
  Action: Re-generate summary with updated prompts
  Auth: Consultant only

GET /api/consultants/[id]/summaries/insights
  Returns: Aggregated insights across all sessions
  Auth: Consultant only
```

---

## UI/UX Design

### Session Summary Page

```
┌─────────────────────────────────────────────────────────┐
│  Session Summary                                        │
│  Consultation with Priya Sharma • Dec 9, 2024          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Overview                                               │
│  ─────────────────────────────────────────────────────  │
│  Discussed Q4 marketing strategy focusing on           │
│  performance marketing and customer acquisition.        │
│  Reviewed current CAC metrics and identified           │
│  optimization opportunities in Meta ads.               │
│                                                         │
│  Duration: 58 minutes | Sentiment: Positive 😊         │
│                                                         │
│  Key Topics Discussed                                   │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  📌 Performance Marketing Strategy                      │
│     Analyzed current Meta and Google ad performance.   │
│     Identified 30% potential improvement in ROAS.      │
│                                                         │
│  📌 Customer Acquisition Cost                          │
│     Current CAC of ₹450 is above target of ₹350.      │
│     Discussed retargeting and lookalike strategies.    │
│                                                         │
│  📌 Q4 Campaign Planning                               │
│     Outlined festive season campaign approach.         │
│     Budget allocation across channels discussed.       │
│                                                         │
│  Action Items                                           │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ☐ Review Meta ad creative performance (You)          │
│    Due: Dec 12                                         │
│                                                         │
│  ☐ Share analytics dashboard access (Priya)           │
│    Due: Dec 10                                         │
│                                                         │
│  ☐ Schedule follow-up for campaign review (Both)      │
│    Due: Dec 20                                         │
│                                                         │
│  Recommendations                                        │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  💡 Increase retargeting budget by 20%                 │
│  💡 Test video creatives for higher engagement         │
│  💡 Implement UTM tracking for all campaigns           │
│                                                         │
│  Consultant Notes                                       │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  "Great progress on understanding funnel metrics.      │
│   Focus on implementing suggested changes before       │
│   our next session."                                   │
│                              — Added by Priya Sharma   │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  [View Full Transcript]  [Download PDF]  [Share]       │
│                                                         │
│  📅 Follow-up Suggested                                │
│  [Book Follow-up Session]                              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Email Notification

```
Subject: Your session summary is ready ✨

Hi [Consultee Name],

Your consultation summary with [Consultant Name] is ready!

📋 Quick Overview:
[2-3 sentence summary]

✅ Action Items:
• [Item 1] - Due [Date]
• [Item 2] - Due [Date]

[View Full Summary →]

Thanks for using Familiarise!
```

### Consultant Insights Dashboard

```
┌─────────────────────────────────────────────────────────┐
│  Session Insights                                       │
│  Based on 47 consultations                             │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Most Discussed Topics                                  │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  █████████████████████  Marketing Strategy (35%)       │
│  ████████████████       Customer Acquisition (28%)     │
│  ██████████             Analytics Setup (18%)          │
│  ██████                 Team Building (12%)            │
│  ████                   Fundraising (7%)               │
│                                                         │
│  Common Questions                                       │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  1. "How do I reduce my CAC?"           (asked 23x)    │
│  2. "What's a good ROAS benchmark?"     (asked 18x)    │
│  3. "When should I hire a growth lead?" (asked 12x)    │
│                                                         │
│  💡 Consider creating content addressing these!        │
│                                                         │
│  Client Sentiment                                       │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Positive: 89% | Neutral: 8% | Mixed: 3%              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Transcription

1. Set up transcription service (Whisper/Deepgram)
2. Trigger transcription after recording upload
3. Store transcript in Recording model
4. Handle long recordings (chunking)

### Phase 2: Summary Generation

1. Implement summary prompt engineering
2. Generate structured JSON summaries
3. Store in Recording.summary
4. Email notification to consultee

### Phase 3: UI & Access

1. Build summary view page
2. Transcript viewer with search
3. PDF export functionality
4. Share summary feature

### Phase 4: Insights & Polish

1. Consultant insights dashboard
2. Topic aggregation across sessions
3. Action item tracking integration
4. Quality improvements to prompts

---

## Dependencies

### Depends On

- Recording model
- MeetingSession model
- Notification system

### Features That Depend On This

- **Analytics Dashboard** - Session content insights

---

## Privacy & Compliance

- Recordings only processed if both parties consented
- Transcripts deletable on request
- Option to disable AI summaries per session
- No third-party storage of transcripts (processed in-memory)
- Clear disclosure that sessions may be transcribed

---

## Cost Considerations

| Service         | Cost (approx)          |
| --------------- | ---------------------- |
| Whisper API     | $0.006/min             |
| Deepgram        | $0.0043/min            |
| AssemblyAI      | $0.00025/sec           |
| Claude 3 Sonnet | $0.003/1K input tokens |
| GPT-4           | $0.01/1K input tokens  |

**Estimated cost per 60-min session**: $0.50 - $1.50

Consider:

- Caching summaries (never re-generate unless requested)
- Batch processing during off-peak hours
- Offering as premium feature
