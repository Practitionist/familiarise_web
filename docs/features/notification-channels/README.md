# Notification Channels (SMS/WhatsApp Reminders)

## Overview

Multi-channel notification system that sends appointment reminders and updates via SMS and WhatsApp in addition to email. Reduces no-shows by up to 50% through timely reminders on channels users actively monitor.

### Value Proposition

- **Reduce No-Shows**: SMS reminders have 98% open rate vs 20% for email
- **Global Reach**: WhatsApp has 2B+ users, dominant in India, Brazil, Europe
- **Instant Delivery**: Real-time notifications for urgent updates
- **User Preference**: Let users choose their preferred channel

---

## User Stories

### Consultees

- As a consultee, I want to receive SMS reminders 24h and 1h before my appointment
- As a consultee, I want to get WhatsApp notifications with quick reply options
- As a consultee, I want to choose which channels I receive notifications on
- As a consultee, I want to easily reschedule via reply to a reminder

### Consultants

- As a consultant, I want to be notified via SMS when someone books
- As a consultant, I want WhatsApp alerts for cancellations
- As a consultant, I want to control which notifications I receive on each channel

### Admins

- As an admin, I want to see delivery rates per channel
- As an admin, I want to manage notification templates
- As an admin, I want to set global notification rules

---

## Technical Architecture

### Database Schema

**No new models required.** Uses existing `NotificationPreference` with extensions:

```prisma
// Existing model - add new fields
model NotificationPreference {
  id                String   @id @default(uuid())
  userId            String   @unique

  // Existing
  allNotifications  Boolean  @default(true)
  mentions          Boolean  @default(true)
  directMessages    Boolean  @default(true)
  updates           Boolean  @default(true)

  // NEW: Channel preferences (can be added as JSON or separate fields)
  // Option A: JSON field (no migration)
  channelPreferences Json?   // { email: true, sms: true, whatsapp: false }

  // Option B: Separate fields (requires migration)
  // emailEnabled      Boolean  @default(true)
  // smsEnabled        Boolean  @default(false)
  // whatsappEnabled   Boolean  @default(false)
  // pushEnabled       Boolean  @default(false)

  user              User     @relation(...)
}

// Use User.phone for SMS/WhatsApp (already exists)
model User {
  phone             String?  // Existing field
  phoneVerified     Boolean  @default(false)  // Optional: add verification
}
```

**Recommendation**: Use JSON `channelPreferences` field to avoid migration.

### Notification Types & Timing

| Event             | Email | SMS | WhatsApp | Timing           |
| ----------------- | ----- | --- | -------- | ---------------- |
| Booking Confirmed | Yes   | Yes | Yes      | Immediate        |
| Reminder          | Yes   | Yes | Yes      | 24h, 1h before   |
| Cancellation      | Yes   | Yes | Yes      | Immediate        |
| Reschedule        | Yes   | Yes | Yes      | Immediate        |
| Payment Success   | Yes   | No  | Optional | Immediate        |
| Payment Failed    | Yes   | Yes | Yes      | Immediate        |
| Review Request    | Yes   | No  | Yes      | 1h after session |

### External Service Providers

| Channel  | Provider Options                   | Recommendation                                   |
| -------- | ---------------------------------- | ------------------------------------------------ |
| SMS      | Twilio, AWS SNS, MSG91, Exotel     | **Twilio** (global) or **MSG91** (India-focused) |
| WhatsApp | Twilio, Meta Business API, Gupshup | **Twilio** (unified API) or **Gupshup** (India)  |
| Push     | Firebase FCM, OneSignal            | **Firebase FCM** (free tier)                     |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Event Trigger                        │
│  (Booking Created, Reminder Cron, Cancellation, etc.)   │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              Notification Service                        │
│  ┌─────────────────────────────────────────────────┐    │
│  │  1. Load user preferences                        │    │
│  │  2. Check channel eligibility (phone verified?)  │    │
│  │  3. Select template for event type               │    │
│  │  4. Dispatch to enabled channels                 │    │
│  └─────────────────────────────────────────────────┘    │
└────────────┬──────────────┬──────────────┬──────────────┘
             │              │              │
             ▼              ▼              ▼
      ┌──────────┐   ┌──────────┐   ┌──────────┐
      │  Email   │   │   SMS    │   │ WhatsApp │
      │ (Resend) │   │ (Twilio) │   │ (Twilio) │
      └──────────┘   └──────────┘   └──────────┘
             │              │              │
             └──────────────┴──────────────┘
                         │
                         ▼
              ┌────────────────────┐
              │  Delivery Tracking │
              │  (Webhook/Status)  │
              └────────────────────┘
```

### API Endpoints

```
GET /api/users/[id]/notification-preferences
  Returns: Current preferences including channel settings

PATCH /api/users/[id]/notification-preferences
  Body: { smsEnabled: true, whatsappEnabled: true, ... }

POST /api/notifications/send
  Body: { userId, type, channel?, data }
  Auth: Internal/Admin only

POST /api/webhooks/twilio
  Handles: Delivery receipts, incoming messages

GET /api/admin/notifications/stats
  Returns: Delivery rates, failure counts by channel
```

### Message Templates

```typescript
// lib/notifications/templates.ts

export const templates = {
  BOOKING_CONFIRMED: {
    sms: (data) =>
      `Familiarise: Your ${data.serviceType} with ${data.consultantName} is confirmed for ${data.dateTime}. Details: ${data.shortUrl}`,

    whatsapp: (data) => ({
      template: 'booking_confirmation',
      components: [
        { type: 'body', parameters: [
          { type: 'text', text: data.consultantName },
          { type: 'text', text: data.dateTime },
          { type: 'text', text: data.serviceName },
        ]}
      ]
    }),

    email: (data) => ({
      subject: `Booking Confirmed: ${data.serviceName}`,
      template: 'booking-confirmed',
      data
    })
  },

  REMINDER_24H: {
    sms: (data) =>
      `Reminder: Your session with ${data.consultantName} is tomorrow at ${data.time}. Reply CANCEL to cancel or RESCHEDULE to change.`,

    whatsapp: (data) => ({
      template: 'appointment_reminder_24h',
      components: [...]
    })
  },

  REMINDER_1H: {
    sms: (data) =>
      `Starting soon! Your session with ${data.consultantName} begins in 1 hour. Join: ${data.meetingUrl}`,

    whatsapp: (data) => ({
      template: 'appointment_reminder_1h',
      components: [...]
    })
  }
};
```

### Notification Service Implementation

```typescript
// lib/notifications/service.ts

import { Twilio } from "twilio";
import { Resend } from "resend";

const twilio = new Twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendNotification(
  userId: string,
  eventType: NotificationEvent,
  data: Record<string, any>,
) {
  // 1. Get user with preferences
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { notificationPreference: true },
  });

  if (!user) throw new Error("User not found");

  const prefs = (user.notificationPreference
    ?.channelPreferences as ChannelPrefs) || {
    email: true,
    sms: false,
    whatsapp: false,
  };

  const template = templates[eventType];
  const results: NotificationResult[] = [];

  // 2. Send to each enabled channel
  if (prefs.email && user.email) {
    results.push(await sendEmail(user.email, template.email(data)));
  }

  if (prefs.sms && user.phone && user.phoneVerified) {
    results.push(await sendSMS(user.phone, template.sms(data)));
  }

  if (prefs.whatsapp && user.phone && user.phoneVerified) {
    results.push(await sendWhatsApp(user.phone, template.whatsapp(data)));
  }

  // 3. Log results
  await logNotifications(userId, eventType, results);

  return results;
}

async function sendSMS(
  phone: string,
  message: string,
): Promise<NotificationResult> {
  try {
    const result = await twilio.messages.create({
      body: message,
      to: phone,
      from: process.env.TWILIO_PHONE_NUMBER,
    });
    return { channel: "sms", status: "sent", messageId: result.sid };
  } catch (error) {
    return { channel: "sms", status: "failed", error: error.message };
  }
}

async function sendWhatsApp(
  phone: string,
  template: WhatsAppTemplate,
): Promise<NotificationResult> {
  try {
    const result = await twilio.messages.create({
      contentSid: template.template,
      contentVariables: JSON.stringify(template.components),
      to: `whatsapp:${phone}`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    });
    return { channel: "whatsapp", status: "sent", messageId: result.sid };
  } catch (error) {
    return { channel: "whatsapp", status: "failed", error: error.message };
  }
}
```

### Reminder Cron Job

```typescript
// app/api/cron/reminders/route.ts

export async function GET(req: NextRequest) {
  // Verify cron secret
  if (
    req.headers.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);

  // Find appointments needing 24h reminder
  const appointments24h = await prisma.slotOfAppointment.findMany({
    where: {
      startTime: {
        gte: new Date(in24Hours.getTime() - 30 * 60 * 1000), // 24h ± 30min
        lte: new Date(in24Hours.getTime() + 30 * 60 * 1000),
      },
      appointment: { status: "SCHEDULED" },
      reminder24hSent: false, // Need to add this field or track separately
    },
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                include: { consultantProfile: { include: { user: true } } },
              },
            },
          },
          // ... other types
        },
      },
    },
  });

  // Send reminders
  for (const slot of appointments24h) {
    await sendNotification(slot.userId, "REMINDER_24H", {
      consultantName: getConsultantName(slot.appointment),
      dateTime: formatDateTime(slot.startTime),
      time: formatTime(slot.startTime),
    });
  }

  // Similar for 1h reminders...

  return NextResponse.json({
    sent24h: appointments24h.length,
    sent1h: appointments1h.length,
  });
}
```

---

## UI/UX Design

### Notification Preferences Page (`/settings/notifications`)

```
┌─────────────────────────────────────────────────────────┐
│  Notification Preferences                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Notification Channels                                  │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Email                                    [Toggle ON]││
│  │ Receive notifications at john@example.com           ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ SMS                                     [Toggle OFF]││
│  │ Add phone number to enable SMS notifications        ││
│  │ [Add Phone Number]                                  ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ WhatsApp                                [Toggle OFF]││
│  │ Requires verified phone number                      ││
│  │ [Connect WhatsApp]                                  ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Notification Types                                     │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  │ Type              │ Email │ SMS │ WhatsApp │        │
│  │───────────────────│───────│─────│──────────│        │
│  │ Booking Confirmed │  ✓    │  ✓  │    ✓     │        │
│  │ Reminders         │  ✓    │  ✓  │    ✓     │        │
│  │ Cancellations     │  ✓    │  ✓  │    ✓     │        │
│  │ Payment Updates   │  ✓    │  -  │    -     │        │
│  │ Marketing         │  ✓    │  -  │    -     │        │
│                                                         │
│  [Save Preferences]                                     │
└─────────────────────────────────────────────────────────┘
```

### Phone Verification Flow

```
┌─────────────────────────────────────────────────────────┐
│  Verify Your Phone Number                               │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Enter your phone number to receive SMS and WhatsApp    │
│  notifications about your appointments.                 │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  🇮🇳 +91  │ 98765 43210                             ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  [Send Verification Code]                               │
│                                                         │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  Enter the 6-digit code sent to your phone:            │
│                                                         │
│  ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐ ┌───┐                  │
│  │ 1 │ │ 2 │ │ 3 │ │ 4 │ │ 5 │ │ 6 │                  │
│  └───┘ └───┘ └───┘ └───┘ └───┘ └───┘                  │
│                                                         │
│  Didn't receive code? [Resend] (available in 30s)      │
│                                                         │
│  [Verify]                                               │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: Infrastructure Setup

1. Set up Twilio account with SMS and WhatsApp Business API
2. Configure environment variables
3. Create notification service with channel abstraction
4. Add `channelPreferences` JSON field to NotificationPreference

### Phase 2: Core Notifications

1. Implement SMS sending via Twilio
2. Implement WhatsApp templates (requires Meta approval)
3. Create reminder cron job
4. Add delivery tracking

### Phase 3: User Settings

1. Build notification preferences UI
2. Implement phone verification flow
3. Add per-notification-type channel controls

### Phase 4: Advanced Features

1. Two-way messaging (reply to reschedule/cancel)
2. Delivery analytics dashboard
3. Fallback logic (SMS if WhatsApp fails)
4. Rate limiting and cost monitoring

---

## Dependencies

### Depends On

- User model with phone field
- NotificationPreference model
- Cron job infrastructure (Vercel Cron or similar)

### Features That Depend On This

- **Waitlist Enhancements** - Notify when slot opens
- **Gift Consultations** - Notify gift recipient

---

## Cost Considerations

| Channel     | Provider    | Cost (approx)                     |
| ----------- | ----------- | --------------------------------- |
| SMS (India) | MSG91       | ₹0.15-0.25 per SMS                |
| SMS (US)    | Twilio      | $0.0079 per SMS                   |
| WhatsApp    | Twilio      | $0.005-0.08 per message           |
| WhatsApp    | Meta Direct | Free for 1000/month, then $0.006+ |

**Recommendation**:

- Use WhatsApp as primary (cheaper, richer)
- SMS as fallback for users without WhatsApp
- Implement cost tracking per user/month

---

## Compliance

- **TCPA (US)**: Require explicit opt-in for SMS marketing
- **GDPR (EU)**: Allow easy opt-out, data deletion
- **TRAI (India)**: Register sender ID, follow DND guidelines
- **WhatsApp Policy**: Use approved templates, no spam
