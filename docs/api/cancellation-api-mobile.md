# Cancellation API - Mobile Integration Guide

This document describes how to implement booking cancellation with structured reasons in the mobile app.

## Overview

When a user cancels a consultation or subscription, we now capture a structured cancellation reason for analytics and customer service purposes.

---

## CancellationReason Enum

```typescript
enum CancellationReason {
  // User-initiated
  SCHEDULE_CONFLICT        // User has a scheduling conflict
  FOUND_ALTERNATIVE        // User found another option
  FINANCIAL_REASONS        // User can no longer afford it
  PERSONAL_EMERGENCY       // Unexpected personal situation
  NO_LONGER_NEEDED         // User no longer needs the service

  // Consultant-initiated
  CONSULTANT_UNAVAILABLE   // Consultant can't make it
  CONSULTANT_EMERGENCY     // Consultant has an emergency

  // System-initiated
  PAYMENT_FAILED           // Payment couldn't be processed
  EXPIRED                  // Booking expired

  // Issue-related
  CONSULTANT_ISSUE         // Problem with the consultant
  TECHNICAL_ISSUE          // Platform technical problems

  // Other
  OTHER                    // Other reason not listed
}
```

---

## API Endpoint

### Cancel Appointment

```http
POST /api/appointments/{appointmentId}/cancel
Authorization: Bearer <token>
Content-Type: application/json

{
  "reason": "SCHEDULE_CONFLICT",
  "notes": "I have a work meeting at this time now"
}
```

**Parameters:**

- `reason` (optional): One of the `CancellationReason` enum values
- `notes` (optional): Free-form text with additional details

**Response (200 OK):**

```json
{
  "success": true,
  "cancellationReason": "SCHEDULE_CONFLICT",
  "cancelledAt": "2025-12-31T10:00:00Z"
}
```

**Backward Compatibility:** The `reason` and `notes` parameters are optional. Existing cancel flows without these fields will continue to work.

---

## UI Implementation

### Recommended Flow

1. User taps "Cancel Booking" button
2. Show modal with reason selection (radio buttons)
3. Include optional notes text field
4. Confirm cancellation
5. Call API with selected reason

### Reason Display Labels

| Enum Value         | Display Label         | Description for User                  |
| ------------------ | --------------------- | ------------------------------------- |
| SCHEDULE_CONFLICT  | Schedule conflict     | I have a scheduling conflict          |
| FOUND_ALTERNATIVE  | Found alternative     | I've found another option             |
| FINANCIAL_REASONS  | Financial reasons     | I can no longer afford this           |
| PERSONAL_EMERGENCY | Personal emergency    | An unexpected situation came up       |
| NO_LONGER_NEEDED   | No longer needed      | I don't need this anymore             |
| CONSULTANT_ISSUE   | Issue with consultant | I'm having issues with the consultant |
| TECHNICAL_ISSUE    | Technical issues      | I'm having technical problems         |
| OTHER              | Other reason          | Another reason not listed             |

### Example Flutter Implementation

```dart
import 'package:flutter/material.dart';

enum CancellationReason {
  scheduleConflict('SCHEDULE_CONFLICT', 'Schedule conflict'),
  foundAlternative('FOUND_ALTERNATIVE', 'Found alternative'),
  financialReasons('FINANCIAL_REASONS', 'Financial reasons'),
  personalEmergency('PERSONAL_EMERGENCY', 'Personal emergency'),
  noLongerNeeded('NO_LONGER_NEEDED', 'No longer needed'),
  consultantIssue('CONSULTANT_ISSUE', 'Issue with consultant'),
  technicalIssue('TECHNICAL_ISSUE', 'Technical issues'),
  other('OTHER', 'Other reason');

  final String apiValue;
  final String displayLabel;

  const CancellationReason(this.apiValue, this.displayLabel);
}

class CancellationReasonSheet extends StatefulWidget {
  final Function(CancellationReason, String?) onConfirm;

  const CancellationReasonSheet({required this.onConfirm});

  @override
  State<CancellationReasonSheet> createState() => _CancellationReasonSheetState();
}

class _CancellationReasonSheetState extends State<CancellationReasonSheet> {
  CancellationReason? _selectedReason;
  final _notesController = TextEditingController();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Why are you cancelling?', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          SizedBox(height: 16),
          ...CancellationReason.values.map((reason) =>
            RadioListTile<CancellationReason>(
              title: Text(reason.displayLabel),
              value: reason,
              groupValue: _selectedReason,
              onChanged: (value) => setState(() => _selectedReason = value),
            )
          ),
          SizedBox(height: 16),
          TextField(
            controller: _notesController,
            decoration: InputDecoration(
              labelText: 'Additional notes (optional)',
              border: OutlineInputBorder(),
            ),
            maxLines: 3,
          ),
          SizedBox(height: 16),
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              TextButton(
                onPressed: () => Navigator.pop(context),
                child: Text('Keep Booking'),
              ),
              SizedBox(width: 8),
              ElevatedButton(
                onPressed: _selectedReason == null
                  ? null
                  : () => widget.onConfirm(
                      _selectedReason!,
                      _notesController.text.isEmpty ? null : _notesController.text
                    ),
                style: ElevatedButton.styleFrom(backgroundColor: Colors.red),
                child: Text('Confirm Cancellation'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
```

### API Client Method

```dart
class ApiClient {
  Future<void> cancelAppointment(
    String appointmentId, {
    CancellationReason? reason,
    String? notes,
  }) async {
    final response = await http.post(
      Uri.parse('$baseUrl/api/appointments/$appointmentId/cancel'),
      headers: {'Authorization': 'Bearer $token', 'Content-Type': 'application/json'},
      body: jsonEncode({
        if (reason != null) 'reason': reason.apiValue,
        if (notes != null) 'notes': notes,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('Failed to cancel appointment');
    }
  }
}
```

---

## Database Changes

The cancellation is stored on the Consultation/Subscription model:

```typescript
model Consultation {
  // ... existing fields ...

  cancellationReason CancellationReason?  // Structured reason
  cancellationNotes  String?               // Free-form notes
  cancelledAt        DateTime?             // When cancelled
  cancelledBy        String?               // User ID who cancelled
}
```

This enables:

1. **Analytics:** "Why do users cancel?" reports
2. **Customer Service:** Staff can see cancellation reason in ticket context
3. **Retention:** Identify patterns and improve service

---

## Error Handling

| HTTP Status | Error                       | Description                      |
| ----------- | --------------------------- | -------------------------------- |
| 401         | Unauthorized                | User not logged in               |
| 400         | Invalid cancellation reason | Unknown reason value             |
| 404         | Appointment not found       | Appointment ID doesn't exist     |
| 500         | Failed to cancel            | Server error during cancellation |

---

## Testing

Test with different cancellation reasons:

```bash
curl -X POST http://localhost:3000/api/appointments/abc123/cancel \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "SCHEDULE_CONFLICT", "notes": "Work meeting"}'
```

---

## Analytics

Admin can view cancellation analytics at:

```
GET /api/admin/analytics/cancellations?startDate=2025-01-01&endDate=2025-12-31
```

Returns aggregated data by reason, type, and time period.

---

## Related Documentation

- [Support Tickets Mobile Guide](./support-tickets-mobile.md)
- Web Issue #280: CancellationReason enum
- Web Issue #281: Swiggy-style support integration
