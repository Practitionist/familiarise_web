# Support Tickets API - Mobile Integration Guide

> **Note:** The Familiarise mobile app uses a separate Dart Frog backend. These docs describe the web API contracts that could be shared with or adapted for the mobile integration.

This document describes how the mobile app should integrate with the shared support ticket system.

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Mobile App    │     │    Web App      │     │ Staff Dashboard │
│   (Flutter)     │     │   (Next.js)     │     │   (Next.js)     │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         └───────────────────────┴───────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │   Shared PostgreSQL DB   │
                    │   (Supabase)            │
                    └─────────────────────────┘
```

**Key Point:** Mobile and Web share the same database. Tickets created from mobile are immediately visible in the web staff dashboard.

---

## Database Models

### SupportTicket

```typescript
model SupportTicket {
  id          String              // UUID
  title       String
  description String
  priority    SupportPriority     // LOW, MEDIUM, HIGH, URGENT
  status      SupportTicketStatus // OPEN, IN_PROGRESS, ON_HOLD, RESOLVED, CLOSED
  category    String?
  issueType   SupportIssueType?   // See enum below

  userId      String              // User who created the ticket

  // Optional entity links (for Swiggy-style context)
  consultationId String?
  subscriptionId String?
  paymentId      String?
  refundId       String?

  assignedToId String?            // Staff member assigned

  createdAt DateTime
  updatedAt DateTime
}
```

### SupportIssueType Enum

```typescript
enum SupportIssueType {
  // Booking Issues
  CONSULTANT_NO_SHOW
  SESSION_QUALITY_POOR
  TECHNICAL_ISSUES
  WRONG_CONSULTANT

  // Payment Issues
  PAYMENT_FAILED
  CHARGED_TWICE
  REFUND_REQUEST

  // Cancellation
  WANT_TO_CANCEL
  CANCELLATION_ISSUE

  // General
  ACCOUNT_ISSUE
  GENERAL_INQUIRY
  OTHER
}
```

### SupportTicketAttachment

```typescript
model SupportTicketAttachment {
  id           String
  fileName     String
  originalName String
  fileSize     Int
  mimeType     String
  fileUrl      String      // Supabase Storage URL
  storagePath  String
  ticketId     String
  uploadedAt   DateTime
}
```

---

## API Endpoints

### Create Support Ticket

```http
POST /api/user/support-tickets
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Session issue",
  "description": "The consultant didn't join the scheduled call",
  "priority": "HIGH",               // Optional: LOW, MEDIUM, HIGH, URGENT
  "issueType": "CONSULTANT_NO_SHOW", // Optional: See enum above
  "consultationId": "clx..."        // Optional: Link to booking for context
}
```

**Response (201 Created):**

```json
{
  "id": "uuid-...",
  "title": "Session issue",
  "description": "The consultant didn't join the scheduled call",
  "priority": "HIGH",
  "status": "OPEN",
  "issueType": "CONSULTANT_NO_SHOW",
  "consultationId": "clx...",
  "createdAt": "2025-12-31T10:00:00Z",
  "updatedAt": "2025-12-31T10:00:00Z",
  "responses": [],
  "attachments": []
}
```

### List User's Tickets

```http
GET /api/user/support-tickets
Authorization: Bearer <token>
```

**Response:**

```json
[
  {
    "id": "uuid-...",
    "title": "Session issue",
    "description": "...",
    "priority": "HIGH",
    "status": "IN_PROGRESS",
    "issueType": "CONSULTANT_NO_SHOW",
    "responses": [
      {
        "id": "uuid-...",
        "message": "We're looking into this for you.",
        "createdAt": "2025-12-31T11:00:00Z",
        "user": {
          "name": "Support Team",
          "role": "STAFF"
        }
      }
    ],
    "attachments": [...],
    "createdAt": "2025-12-31T10:00:00Z",
    "updatedAt": "2025-12-31T11:00:00Z"
  }
]
```

### Add Response to Ticket

```http
POST /api/user/support-tickets/{ticketId}/responses
Authorization: Bearer <token>
Content-Type: application/json

{
  "message": "Thanks for looking into this. Here's more detail..."
}
```

**Response (201 Created):**

```json
{
  "id": "uuid-...",
  "message": "Thanks for looking into this...",
  "createdAt": "2025-12-31T12:00:00Z",
  "user": {
    "name": "John Doe",
    "role": "CONSULTEE"
  }
}
```

### Upload Attachment

```http
POST /api/support-tickets/{ticketId}/attachments
Authorization: Bearer <token>
Content-Type: multipart/form-data

file: <binary file data>
```

**Response (201 Created):**

```json
{
  "attachment": {
    "id": "uuid-...",
    "fileName": "1735645200000_screenshot.png",
    "originalName": "screenshot.png",
    "fileSize": 102400,
    "mimeType": "image/png",
    "fileUrl": "https://xxx.supabase.co/storage/v1/object/public/..."
  }
}
```

**Limits:**

- Max file size: 10MB
- Max 5 attachments per ticket
- Allowed types: PDF, Word docs, images (JPG, PNG, GIF, WebP), text files

---

## Status Flow

```
Mobile: Creates ticket (OPEN)
    ↓
Web Admin: Responds (status → IN_PROGRESS)
    ↓
Mobile: User sees response
    ↓
Web Admin: Resolves (status → RESOLVED)
    ↓
Mobile: User sees resolved status
```

---

## Implementation Notes for Mobile

### 1. Polling for Updates

Since we don't have push notifications in scope, implement polling:

```dart
// Poll every 60 seconds for ticket updates
Timer.periodic(Duration(seconds: 60), (timer) async {
  final tickets = await apiClient.getUserTickets();
  // Update local state and show notification badge if new responses
});
```

### 2. Linking to Bookings

When creating a ticket about a specific booking:

```dart
await apiClient.createSupportTicket(
  title: "Issue with my consultation",
  description: userDescription,
  issueType: SupportIssueType.consultantNoShow,
  consultationId: booking.consultationId, // Link to specific booking
);
```

This allows staff to see the booking context when handling the ticket.

### 3. Handling New Enum Values

The mobile app should handle unknown enum values gracefully:

```dart
SupportIssueType parseIssueType(String? value) {
  if (value == null) return null;
  try {
    return SupportIssueType.values.byName(value);
  } catch (_) {
    return SupportIssueType.other; // Fallback for unknown values
  }
}
```

### 4. Attachment Uploads

Use the same Supabase bucket pattern as web:

- Bucket: `support-attachments`
- Path: `support-tickets/{ticketId}/{timestamp}_{filename}`

```dart
// Example using Supabase Dart client
final fileBytes = await file.readAsBytes();
final path = 'support-tickets/$ticketId/${DateTime.now().millisecondsSinceEpoch}_${file.name}';

await supabase.storage
  .from('support-attachments')
  .uploadBinary(path, fileBytes);
```

---

## Error Handling

| HTTP Status | Error                   | Description                                                 |
| ----------- | ----------------------- | ----------------------------------------------------------- |
| 401         | Unauthorized            | User not logged in                                          |
| 400         | Invalid issue type      | Unknown issueType value                                     |
| 400         | Invalid consultation ID | Linked consultation doesn't exist or doesn't belong to user |
| 404         | Ticket not found        | Ticket ID doesn't exist                                     |
| 500         | Server error            | Something went wrong                                        |

---

## Testing

For local development, the API accepts tickets without real authentication when `NODE_ENV=development`.

To test the full flow:

1. Create a ticket from mobile
2. Check the web staff dashboard - ticket should appear immediately
3. Respond from staff dashboard
4. Poll from mobile - response should appear

---

## Related Issues

- familiarise_mobile#16: Customer Support MVP
- familiarise_mobile#17: Mobile backend support tickets
- familiarise_web#280: CancellationReason enum
- familiarise_web#281: Swiggy-style support integration
