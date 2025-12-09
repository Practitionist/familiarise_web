# Calendar Sync

## Overview

Bi-directional calendar synchronization between the platform and external calendar providers (Google Calendar, Microsoft Outlook, Apple Calendar). Consultants' availability automatically updates from their calendar, and booked appointments sync back to both parties' calendars.

### Value Proposition

- **No Double-Bookings**: Real-time sync prevents scheduling conflicts
- **Automatic Updates**: Appointments appear in users' preferred calendars
- **Professional Integration**: Seamless workflow with existing tools
- **Time Savings**: No manual calendar entry required

---

## User Stories

### Consultants

- As a consultant, I want to connect my Google Calendar so busy times block my availability
- As a consultant, I want booked appointments to automatically appear in my calendar
- As a consultant, I want to manage multiple calendars (personal + work)
- As a consultant, I want calendar events to include meeting links and client details

### Consultees

- As a consultee, I want my booked sessions to sync to my calendar
- As a consultee, I want calendar invites with one-click join links
- As a consultee, I want reminders from my native calendar app

---

## Technical Architecture

### Database Schema

**No new models required.** Store calendar tokens securely:

```prisma
// Option A: Use existing Account model (NextAuth already stores OAuth tokens)
model Account {
  // Existing NextAuth fields...
  provider          String  // "google", "microsoft", etc.
  access_token      String?
  refresh_token     String?
  expires_at        Int?

  // Calendar-specific (already available via provider)
}

// Option B: Add calendar-specific preferences to User (JSON field)
model User {
  // Existing fields...
  calendarSettings  Json?  // { primaryCalendarId, syncEnabled, syncDirection }
}

// Option C: Dedicated CalendarConnection model (if more control needed)
// model CalendarConnection {
//   id              String @id @default(cuid())
//   userId          String
//   provider        CalendarProvider // GOOGLE, MICROSOFT, APPLE
//   calendarId      String           // Primary calendar to sync
//   accessToken     String           // Encrypted
//   refreshToken    String           // Encrypted
//   expiresAt       DateTime
//   syncEnabled     Boolean @default(true)
//   syncDirection   SyncDirection @default(BIDIRECTIONAL)
//   lastSyncAt      DateTime?
//   user            User @relation(...)
// }
```

**Recommendation**: Use existing NextAuth Account model + User.calendarSettings JSON.

### Sync Directions

```
┌─────────────────────────────────────────────────────────┐
│                  SYNC DIRECTIONS                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. INBOUND (Calendar → Platform)                       │
│     ─────────────────────────────                       │
│     - Read busy times from external calendar            │
│     - Block availability slots automatically            │
│     - Trigger: Periodic poll OR webhook                 │
│                                                         │
│  2. OUTBOUND (Platform → Calendar)                      │
│     ─────────────────────────────                       │
│     - Create calendar events for bookings               │
│     - Include meeting link, attendee info               │
│     - Trigger: On booking/cancellation                  │
│                                                         │
│  3. BIDIRECTIONAL (Both)                                │
│     ─────────────────────────────                       │
│     - Full sync in both directions                      │
│     - Recommended for consultants                       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Provider Integration

| Provider | OAuth | Calendar API | Webhook Support |
|----------|-------|--------------|-----------------|
| Google Calendar | OAuth 2.0 | Google Calendar API v3 | Push notifications |
| Microsoft Outlook | OAuth 2.0 | Microsoft Graph API | Subscriptions |
| Apple Calendar | OAuth 2.0 | CalDAV | Polling only |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    Platform                              │
│  ┌─────────────────────────────────────────────────┐    │
│  │              Calendar Service                    │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐           │    │
│  │  │ Google  │ │Microsoft│ │  Apple  │           │    │
│  │  │ Adapter │ │ Adapter │ │ Adapter │           │    │
│  │  └────┬────┘ └────┬────┘ └────┬────┘           │    │
│  │       │           │           │                 │    │
│  │       └───────────┴───────────┘                 │    │
│  │                   │                             │    │
│  │  ┌────────────────┴────────────────┐           │    │
│  │  │    Unified Calendar Interface    │           │    │
│  │  │  - getBusyTimes()                │           │    │
│  │  │  - createEvent()                 │           │    │
│  │  │  - updateEvent()                 │           │    │
│  │  │  - deleteEvent()                 │           │    │
│  │  └─────────────────────────────────┘           │    │
│  └─────────────────────────────────────────────────┘    │
│                         │                                │
│    ┌────────────────────┼────────────────────┐          │
│    │                    │                    │          │
│    ▼                    ▼                    ▼          │
│ ┌──────────┐    ┌──────────────┐    ┌──────────────┐   │
│ │Availability│   │ Appointment  │    │   Booking    │   │
│ │  Service  │    │   Service    │    │   Service    │   │
│ └──────────┘    └──────────────┘    └──────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### API Endpoints

```
POST /api/calendar/connect
  Body: { provider: 'google' | 'microsoft' | 'apple' }
  Returns: OAuth redirect URL

GET /api/calendar/callback
  Handles: OAuth callback, stores tokens

GET /api/calendar/status
  Returns: { connected: boolean, provider, lastSync, calendars[] }

POST /api/calendar/sync
  Body: { direction: 'inbound' | 'outbound' | 'both' }
  Triggers: Manual sync

DELETE /api/calendar/disconnect
  Removes: Calendar connection

GET /api/calendar/busy-times
  Query: ?start=ISO&end=ISO
  Returns: Array of busy time blocks

POST /api/webhooks/google-calendar
  Handles: Push notification from Google
```

### Calendar Service Implementation

```typescript
// lib/calendar/service.ts

import { google } from 'googleapis';
import { Client } from '@microsoft/microsoft-graph-client';

export interface CalendarEvent {
  id?: string;
  title: string;
  description?: string;
  start: Date;
  end: Date;
  location?: string;
  meetingUrl?: string;
  attendees?: { email: string; name?: string }[];
}

export interface BusyTime {
  start: Date;
  end: Date;
  calendarId?: string;
}

export abstract class CalendarProvider {
  abstract getBusyTimes(start: Date, end: Date): Promise<BusyTime[]>;
  abstract createEvent(event: CalendarEvent): Promise<string>;
  abstract updateEvent(eventId: string, event: Partial<CalendarEvent>): Promise<void>;
  abstract deleteEvent(eventId: string): Promise<void>;
  abstract listCalendars(): Promise<{ id: string; name: string; primary: boolean }[]>;
}

// Google Calendar Implementation
export class GoogleCalendarProvider extends CalendarProvider {
  private calendar;

  constructor(accessToken: string, refreshToken: string) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
    this.calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  }

  async getBusyTimes(start: Date, end: Date): Promise<BusyTime[]> {
    const response = await this.calendar.freebusy.query({
      requestBody: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        items: [{ id: 'primary' }],
      },
    });

    const busy = response.data.calendars?.primary?.busy || [];
    return busy.map(b => ({
      start: new Date(b.start!),
      end: new Date(b.end!),
    }));
  }

  async createEvent(event: CalendarEvent): Promise<string> {
    const response = await this.calendar.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      requestBody: {
        summary: event.title,
        description: event.description,
        start: { dateTime: event.start.toISOString() },
        end: { dateTime: event.end.toISOString() },
        location: event.meetingUrl || event.location,
        attendees: event.attendees?.map(a => ({ email: a.email, displayName: a.name })),
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 },
            { method: 'popup', minutes: 10 },
          ],
        },
      },
    });

    return response.data.id!;
  }

  async updateEvent(eventId: string, event: Partial<CalendarEvent>): Promise<void> {
    await this.calendar.events.patch({
      calendarId: 'primary',
      eventId,
      requestBody: {
        summary: event.title,
        description: event.description,
        start: event.start ? { dateTime: event.start.toISOString() } : undefined,
        end: event.end ? { dateTime: event.end.toISOString() } : undefined,
      },
    });
  }

  async deleteEvent(eventId: string): Promise<void> {
    await this.calendar.events.delete({
      calendarId: 'primary',
      eventId,
    });
  }

  async listCalendars() {
    const response = await this.calendar.calendarList.list();
    return response.data.items?.map(c => ({
      id: c.id!,
      name: c.summary!,
      primary: c.primary || false,
    })) || [];
  }
}

// Microsoft Graph Implementation
export class MicrosoftCalendarProvider extends CalendarProvider {
  private client: Client;

  constructor(accessToken: string) {
    this.client = Client.init({
      authProvider: (done) => done(null, accessToken),
    });
  }

  async getBusyTimes(start: Date, end: Date): Promise<BusyTime[]> {
    const response = await this.client
      .api('/me/calendar/getSchedule')
      .post({
        schedules: ['me'],
        startTime: { dateTime: start.toISOString(), timeZone: 'UTC' },
        endTime: { dateTime: end.toISOString(), timeZone: 'UTC' },
      });

    const items = response.value[0]?.scheduleItems || [];
    return items.map((item: any) => ({
      start: new Date(item.start.dateTime),
      end: new Date(item.end.dateTime),
    }));
  }

  async createEvent(event: CalendarEvent): Promise<string> {
    const response = await this.client.api('/me/calendar/events').post({
      subject: event.title,
      body: { contentType: 'text', content: event.description || '' },
      start: { dateTime: event.start.toISOString(), timeZone: 'UTC' },
      end: { dateTime: event.end.toISOString(), timeZone: 'UTC' },
      location: { displayName: event.location || event.meetingUrl },
      attendees: event.attendees?.map(a => ({
        emailAddress: { address: a.email, name: a.name },
        type: 'required',
      })),
    });

    return response.id;
  }

  // ... updateEvent, deleteEvent, listCalendars
}

// Factory
export function getCalendarProvider(
  provider: 'google' | 'microsoft',
  tokens: { accessToken: string; refreshToken?: string }
): CalendarProvider {
  switch (provider) {
    case 'google':
      return new GoogleCalendarProvider(tokens.accessToken, tokens.refreshToken!);
    case 'microsoft':
      return new MicrosoftCalendarProvider(tokens.accessToken);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
```

### Availability Integration

```typescript
// lib/availability/calendar-sync.ts

export async function getAvailableSlots(
  consultantProfileId: string,
  date: Date
): Promise<TimeSlot[]> {
  const consultant = await prisma.consultantProfile.findUnique({
    where: { id: consultantProfileId },
    include: { user: { include: { accounts: true } } },
  });

  // 1. Get platform availability slots
  const platformSlots = await getPlatformAvailability(consultantProfileId, date);

  // 2. Get external calendar busy times
  const calendarAccount = consultant?.user.accounts.find(
    a => a.provider === 'google' || a.provider === 'azure-ad'
  );

  let busyTimes: BusyTime[] = [];
  if (calendarAccount?.access_token) {
    const provider = getCalendarProvider(
      calendarAccount.provider as 'google' | 'microsoft',
      { accessToken: calendarAccount.access_token, refreshToken: calendarAccount.refresh_token }
    );

    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);
    busyTimes = await provider.getBusyTimes(dayStart, dayEnd);
  }

  // 3. Subtract busy times from available slots
  const availableSlots = subtractBusyTimes(platformSlots, busyTimes);

  return availableSlots;
}

function subtractBusyTimes(slots: TimeSlot[], busyTimes: BusyTime[]): TimeSlot[] {
  return slots.filter(slot => {
    return !busyTimes.some(busy =>
      (slot.start >= busy.start && slot.start < busy.end) ||
      (slot.end > busy.start && slot.end <= busy.end)
    );
  });
}
```

### Booking Calendar Sync

```typescript
// lib/booking/calendar-sync.ts

export async function syncBookingToCalendars(appointmentId: string): Promise<void> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      slotOfAppointments: { include: { user: { include: { accounts: true } } } },
      consultation: {
        include: {
          consultationPlan: { include: { consultantProfile: { include: { user: { include: { accounts: true } } } } } },
          consulteeProfile: { include: { user: { include: { accounts: true } } } },
        },
      },
      // ... other appointment types
    },
  });

  if (!appointment) return;

  const slot = appointment.slotOfAppointments[0];
  const consultant = getConsultantFromAppointment(appointment);
  const consultee = getConsulteeFromAppointment(appointment);
  const meetingSession = await getMeetingSession(appointmentId);

  const event: CalendarEvent = {
    title: `Consultation: ${consultant.name} & ${consultee.name}`,
    description: `Consultation session via Familiarise\n\nJoin: ${meetingSession?.meetingUrl}`,
    start: slot.startTime,
    end: slot.endTime,
    meetingUrl: meetingSession?.meetingUrl,
    attendees: [
      { email: consultant.email, name: consultant.name },
      { email: consultee.email, name: consultee.name },
    ],
  };

  // Sync to consultant's calendar
  if (consultant.calendarAccount) {
    const provider = getCalendarProvider(consultant.calendarAccount.provider, consultant.calendarAccount);
    const eventId = await provider.createEvent(event);
    await storeCalendarEventId(appointmentId, 'consultant', eventId);
  }

  // Sync to consultee's calendar
  if (consultee.calendarAccount) {
    const provider = getCalendarProvider(consultee.calendarAccount.provider, consultee.calendarAccount);
    const eventId = await provider.createEvent(event);
    await storeCalendarEventId(appointmentId, 'consultee', eventId);
  }
}
```

---

## UI/UX Design

### Calendar Connection Settings (`/settings/calendar`)

```
┌─────────────────────────────────────────────────────────┐
│  Calendar Integration                                   │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Connect your calendar to automatically sync            │
│  appointments and block busy times.                     │
│                                                         │
│  Connected Calendars                                    │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 📅 Google Calendar                      [Connected] ││
│  │    john@gmail.com                                   ││
│  │    Last synced: 5 minutes ago                       ││
│  │                                                     ││
│  │    Primary Calendar: Work Calendar  [Change ▼]     ││
│  │    Sync Direction:   Bidirectional  [Change ▼]     ││
│  │                                                     ││
│  │    [Sync Now]  [Disconnect]                        ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  Add Calendar                                           │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Google     │  │  Microsoft   │  │    Apple     │  │
│  │  Calendar    │  │   Outlook    │  │   Calendar   │  │
│  │              │  │              │  │              │  │
│  │  [Connect]   │  │  [Connect]   │  │  [Connect]   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  Sync Settings                                          │
│  ─────────────────────────────────────────────────────  │
│                                                         │
│  ☑ Block availability when calendar shows busy         │
│  ☑ Create calendar events for new bookings             │
│  ☑ Send calendar invites to clients                    │
│  ☐ Include private event details in sync               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Availability View with Calendar Overlay

```
┌─────────────────────────────────────────────────────────┐
│  Your Availability - December 2024                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Legend: █ Available  ░ External Busy  ▓ Booked        │
│                                                         │
│  Monday, Dec 9                                          │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 09:00  ████████████████████████  Available          ││
│  │ 10:00  ░░░░░░░░░░░░░░░░░░░░░░░░  Team Meeting (GCal)││
│  │ 11:00  ████████████████████████  Available          ││
│  │ 12:00  ░░░░░░░░░░░░░░░░░░░░░░░░  Lunch (GCal)       ││
│  │ 13:00  ████████████████████████  Available          ││
│  │ 14:00  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  Booked: John Doe   ││
│  │ 15:00  ████████████████████████  Available          ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Implementation Approach

### Phase 1: OAuth Setup

1. Configure Google OAuth with Calendar scope
2. Configure Microsoft OAuth with Calendar scope
3. Store tokens in Account model (NextAuth)
4. Build connection UI

### Phase 2: Outbound Sync (Platform → Calendar)

1. Create events on booking confirmation
2. Update events on reschedule
3. Delete events on cancellation
4. Include meeting URLs and attendee info

### Phase 3: Inbound Sync (Calendar → Platform)

1. Implement freebusy query for each provider
2. Integrate with availability calculation
3. Add visual indicator for external busy times
4. Set up periodic sync (every 15 minutes)

### Phase 4: Advanced Features

1. Push notification / webhook for real-time updates
2. Multi-calendar support (select which calendars to sync)
3. Conflict resolution UI
4. Calendar event templates

---

## Dependencies

### Depends On

- NextAuth OAuth integration
- SlotOfAvailability models
- MeetingSession for video links

### Features That Depend On This

- **Buffer Times** - Include buffers in calendar events
- **Smart Matching** - Consider calendar availability

---

## Security & Privacy

- Tokens encrypted at rest
- Minimal scope: Only calendar read/write, not contacts or email
- Users can disconnect at any time
- Private event details not synced by default
- Clear disclosure of what data is accessed
