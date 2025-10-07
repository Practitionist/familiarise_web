# Event Types and Scheduling Guide

## Overview

This document explains the four types of events in Familiarise and how slot selection works for each type.

---

## 📋 Understanding the Calendar UI Message

When you open the scheduling calendar, you'll see a message like:

```
Select slots for 4 calls (1 hour each) | Limit: 2/week
Required: 1h per call (2 consecutive slots per call)
```

### Breaking Down the Message

- **"4 calls"** - Total number of video call sessions to schedule
- **"1 hour each"** - Duration of each individual call
- **"Limit: 2/week"** - Maximum number of calls allowed per calendar week
- **"2 consecutive slots per call"** - Since the calendar uses 30-minute intervals, a 1-hour call requires selecting 2 back-to-back slots

### Example

For a 1-hour call:

- ✅ **Correct**: Select 14:00 + 14:30 (consecutive, no gap)
- ❌ **Wrong**: Select 14:00 + 15:00 (30-minute gap in between)

---

## 📚 The Four Event Types

### 1. CONSULTATION 💼

**Purpose**: One-time professional advice or discussion session

**Characteristics**:

- Single video call
- Typically 1 hour duration
- One-on-one with consultant
- Pay-per-session model

**Scheduling Example**:

```
Select slots for 1 call (1 hour) | No weekly limit
Required: 1h per call (2 consecutive slots per call)
```

**What This Means**:

- Book ONE video call only
- Call duration is 1 hour
- Select 2 consecutive 30-minute slots (e.g., 15:00 + 15:30)
- No restrictions on when you book it
- Book any available day/time

**Use Cases**:

- Career advice session
- One-time technical consultation
- Portfolio review
- Interview preparation

---

### 2. SUBSCRIPTION 📅

**Purpose**: Ongoing relationship with regular sessions over weeks/months

**Characteristics**:

- Multiple calls spread over time (typically 4-20 calls)
- Each call is 1 hour
- One-on-one with consultant
- Weekly call limits to ensure proper pacing
- Subscription duration: 1-12 months

**Scheduling Example**:

```
Select slots for 8 calls (1 hour each) | Limit: 2/week
Required: 1h per call (2 consecutive slots per call)
```

**What This Means**:

- Book 8 video calls total
- Each call is 1 hour long
- Maximum 2 calls per week
- Must spread calls across at least 4 weeks
- Select 2 consecutive slots per call

**Example Schedule**:

```
Week 1 (Jan 1-7):
  - Monday 14:00-15:00 ✅
  - Thursday 10:00-11:00 ✅
  - Friday 16:00-17:00 ❌ (exceeds 2/week limit)

Week 2 (Jan 8-14):
  - Tuesday 16:00-17:00 ✅
  - Friday 09:00-10:00 ✅

Week 3 (Jan 15-21):
  - Wednesday 11:00-12:00 ✅
  - Thursday 14:00-15:00 ✅

Week 4 (Jan 22-28):
  - Monday 10:00-11:00 ✅
  - Wednesday 15:00-16:00 ✅

Total: 8 calls scheduled across 4 weeks
```

**Why the Weekly Limit?**

- Prevents rushing through content
- Allows time for homework/practice between sessions
- Ensures sustained learning over time
- Prevents consultant burnout

**Common Configurations**:

- **Basic** (1 month): 4 calls @ 1/week
- **Extended** (6 months): 12 calls @ 2/week
- **Comprehensive** (12 months): 24 calls @ 2/week

**Use Cases**:

- Long-term mentorship
- Career coaching program
- Skill development over time
- Ongoing technical guidance

---

### 3. WEBINAR 🎓

**Purpose**: One-time live group presentation or workshop

**Characteristics**:

- Single session
- Longer duration (1-3 hours typical)
- Multiple attendees (group event)
- Presentation + Q&A format
- One-to-many model

**Scheduling Example**:

```
Select slots for 1 session (2 hours) | No weekly limit
Required: 2h per session (4 consecutive slots)
```

**What This Means**:

- Book ONE group webinar session
- Session is 2 hours long
- Select 4 consecutive 30-minute slots
  - Example: 14:00 + 14:30 + 15:00 + 15:30
- Multiple people attend the same webinar
- No weekly restrictions (one-time event)

**Example Slot Selection**:

```
Webinar: "Introduction to System Design"
Duration: 2 hours
Slots needed: 4 consecutive

Option 1:
  14:00 ✅
  14:30 ✅
  15:00 ✅
  15:30 ✅
  = 2-hour block from 14:00-16:00

Option 2:
  18:00 ✅
  18:30 ✅
  19:00 ✅
  19:30 ✅
  = 2-hour block from 18:00-20:00
```

**Use Cases**:

- Product launch presentation
- Educational workshop
- Industry trends discussion
- Live training session
- Panel discussion

---

### 4. CLASS 📖

**Purpose**: Multi-week course with recurring group sessions

**Characteristics**:

- Multiple sessions (typically 8-16 sessions)
- Each session is 1 hour
- Multiple students in each session
- Weekly pacing (1 session per week typical)
- Structured curriculum over months
- Group learning environment

**Scheduling Example**:

```
Select slots for 12 sessions (1 hour each) | Limit: 1/week
Required: 1h per session (2 consecutive slots per session)
```

**What This Means**:

- Book 12 group class sessions
- Each session is 1 hour
- Maximum 1 session per week
- Spread across 12 weeks (3 months)
- Select 2 consecutive slots per session
- Multiple students attend the same class

**Example Schedule**:

```
12-Week "Advanced React" Course
Weekly classes every Monday 18:00-19:00

Week 1:  Jan 8,  18:00-19:00 - Introduction to Hooks
Week 2:  Jan 15, 18:00-19:00 - State Management
Week 3:  Jan 22, 18:00-19:00 - useEffect Deep Dive
Week 4:  Jan 29, 18:00-19:00 - Custom Hooks
Week 5:  Feb 5,  18:00-19:00 - Context API
Week 6:  Feb 12, 18:00-19:00 - Performance Optimization
Week 7:  Feb 19, 18:00-19:00 - Testing React Apps
Week 8:  Feb 26, 18:00-19:00 - Advanced Patterns
Week 9:  Mar 5,  18:00-19:00 - Server Components
Week 10: Mar 12, 18:00-19:00 - SSR and SSG
Week 11: Mar 19, 18:00-19:00 - Project Workshop
Week 12: Mar 26, 18:00-19:00 - Final Presentations
```

**Why the Weekly Limit?**

- Students need time to complete homework
- Practice and absorption between sessions
- Prevents cognitive overload
- Follows traditional course pacing
- Allows for assignments and projects

**Use Cases**:

- Structured course over multiple weeks
- Bootcamp-style training
- Certification preparation
- Group study program

---

## 🎯 Key Differences Summary

| Type             | Duration       | Total Sessions | Weekly Limit | Attendees | Payment Model    |
| ---------------- | -------------- | -------------- | ------------ | --------- | ---------------- |
| **Consultation** | 1 hour         | 1 call         | None         | 1-on-1    | Pay per session  |
| **Subscription** | 1 hour/call    | 4-24 calls     | 1-3/week     | 1-on-1    | Monthly/plan fee |
| **Webinar**      | 1-3 hours      | 1 session      | None         | Group     | Pay per seat     |
| **Class**        | 1 hour/session | 8-16 sessions  | 1/week       | Group     | Pay per course   |

---

## 📅 Scheduling Rules and Constraints

### Consecutive Slots Requirement

**Definition**: Time slots must be back-to-back with no gaps

✅ **Valid Examples**:

```
1-hour call (2 slots):
  14:00 → 14:30 (consecutive)

2-hour session (4 slots):
  14:00 → 14:30 → 15:00 → 15:30 (all consecutive)
```

❌ **Invalid Examples**:

```
1-hour call with gap:
  14:00, 15:00 (has 30-minute gap at 14:30)

2-hour session with gap:
  14:00 → 14:30 → [GAP] → 15:30 → 16:00
```

### Weekly Limit Enforcement

**How It Works**:

- Calendar week runs Sunday-Saturday
- System counts completed calls for current week
- Blocks selection when limit reached

**Example: 2/week limit**

```
Week of Jan 1-7:
  - Monday 10:00 (Call 1) ✅
  - Tuesday 14:00 (Call 2) ✅
  - Wednesday 16:00 (Call 3) ❌ BLOCKED - "Weekly Call Limit Reached"

Week of Jan 8-14:
  - Counter resets
  - Can select 2 more calls ✅
```

### Scheduling Period Boundaries

**For Subscriptions and Classes**:

- Must schedule within subscription/class date range
- Slots outside this period show as "Outside Period" (green, disabled)
- Click shows toast: "This subscription allows scheduling only between [dates]"

**Example**:

```
Subscription Period: Sep 22, 2025 - Oct 2, 2025

Sep 28 (within period):
  - 14:00 Available ✅ (can book)

Oct 5 (outside period):
  - 14:00 Outside Period 🚫 (shows toast, cannot book)
```

---

## 🎨 Calendar Visual Guide

### Slot States and Colors

| State                | Color        | Opacity                     | Clickable | Meaning                                 |
| -------------------- | ------------ | --------------------------- | --------- | --------------------------------------- |
| **Available**        | Green        | 100% (future)<br>50% (past) | Yes       | Can book this slot                      |
| **Outside Period**   | Green        | 100% (future)<br>50% (past) | Yes       | Shows toast explaining date restriction |
| **Booked**           | Gray         | 100% (future)<br>50% (past) | Yes       | Shows appointment details in toast      |
| **Partially Booked** | Yellow       | 100% (future)<br>50% (past) | Yes       | Shows conflicting appointments          |
| **No Availability**  | Light Gray   | 70%                         | No        | Consultant doesn't work these hours     |
| **Selected**         | Blue/Primary | 100%                        | Yes       | Currently selected for booking          |

### Hover Effects

- **Available slots**: Brighten to light green
- **Booked slots**: Darken to darker gray
- **Partially Booked**: Darken to darker yellow
- **Outside Period**: Brighten to light green (but still disabled)
- **No Availability**: No hover effect

---

## 💡 Common Questions

### Q: Why can't I select more calls this week?

**A:** You've reached the weekly limit for your subscription/class. The limit ensures:

- Proper pacing of content
- Time for homework and practice
- Sustainable learning pace
- Consultant availability management

**Solution**: Select calls in subsequent weeks

---

### Q: Why do I see "Outside Period" on future dates?

**A:** Your subscription or class has a defined scheduling period. Slots outside this period (before start date or after end date) cannot be booked.

**Example**:

- Subscription: Oct 1 - Oct 30
- Viewing: Nov 1-7
- All slots show "Outside Period" because November is after subscription ends

---

### Q: Why do I need to select 2 slots for a 1-hour call?

**A:** The calendar uses 30-minute time intervals. A 1-hour call requires two consecutive 30-minute slots:

- Slot 1: 14:00-14:30
- Slot 2: 14:30-15:00
- Combined: 14:00-15:00 (1 hour)

This allows flexible scheduling at half-hour increments.

---

### Q: Can I book multiple consultations on the same day?

**A:** Yes! Consultations have no weekly limits. You can book multiple consultations in the same day or week as long as the consultant has availability.

---

### Q: What happens if I select slots on the wrong days?

**A:** The system validates your selection:

- For subscriptions with 2/week limit: You can select max 2 complete calls per week
- For classes with 1/week limit: You can select max 1 complete session per week
- If you try to exceed the limit, a toast notification explains the restriction

---

## 🔧 Technical Implementation Notes

### Slot Duration Calculation

```typescript
// Session duration defines required consecutive slots
const sessionDurationInHours = 1;
const slotIntervalMinutes = 30;
const requiredConsecutiveSlots =
  (sessionDurationInHours * 60) / slotIntervalMinutes;
// Result: 2 consecutive slots needed for 1-hour session
```

### Weekly Limit Validation

```typescript
// Check if adding new call would exceed weekly limit
const weekStart = startOfWeek(selectedDate);
const weekEnd = endOfWeek(selectedDate);
const callsThisWeek = countCallsInRange(weekStart, weekEnd);

if (callsThisWeek >= callsPerWeek) {
  showToast("Weekly Call Limit Reached");
  return;
}
```

### Scheduling Period Validation

```typescript
// Check if slot is within allowed period
const isOutsideRange =
  (allowedStart && slotStart < allowedStart) ||
  (allowedEnd && slotStart >= allowedEnd);

if (isOutsideRange) {
  showToast("Slot outside allowed period");
  return;
}
```

---

## 📖 Related Documentation

- [Calendar Display Algorithm](./CALENDAR_DISPLAY_ANALYSIS.md) - Technical deep dive into calendar rendering
- [Data Quality Monitoring](../utils/dataQualityMonitoring.ts) - Slot validation utilities
- [Slot Processing](../utils/timeSlotsProcessing.ts) - Availability calculation logic

---

**Last Updated**: January 2025
**Version**: 1.0
