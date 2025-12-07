# API Reference

Complete API documentation for all booking algorithm endpoints.

## Overview

The booking algorithm exposes 8 endpoints (2 per event type):

| Event Type        | Validate Endpoint                              | Allocate Endpoint                               |
| ----------------- | ---------------------------------------------- | ----------------------------------------------- |
| **Consultations** | `POST /api/events/consultations/{id}/validate` | `PATCH /api/events/consultations/{id}/allocate` |
| **Subscriptions** | `POST /api/events/subscriptions/{id}/validate` | `PATCH /api/events/subscriptions/{id}/allocate` |
| **Webinars**      | `POST /api/events/webinars/{id}/validate`      | `PATCH /api/events/webinars/{id}/allocate`      |
| **Classes**       | `POST /api/events/classes/{id}/validate`       | `PATCH /api/events/classes/{id}/allocate`       |

**Base URL**: `https://your-domain.com`

**Authentication**: Required (assumes session-based auth or JWT)

---

## Validate Endpoints

Validate proposed time slots without creating appointments.

### Request Format

**Method**: `POST`

**URL Pattern**: `/api/events/{eventType}/{eventId}/validate`

**Headers**:

```
Content-Type: application/json
Authorization: Bearer {token}
```

**URL Parameters**:

| Parameter   | Type          | Description                                                          | Example                                |
| ----------- | ------------- | -------------------------------------------------------------------- | -------------------------------------- |
| `eventType` | string        | Event type (`consultations`, `subscriptions`, `webinars`, `classes`) | `consultations`                        |
| `eventId`   | string (UUID) | Unique event identifier                                              | `550e8400-e29b-41d4-a716-446655440000` |

**Request Body**:

```typescript
{
  slots: string[] // Array of ISO 8601 datetime strings
}
```

**Example Request**:

```bash
curl -X POST https://your-domain.com/api/events/consultations/550e8400-e29b-41d4-a716-446655440000/validate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "slots": [
      "2025-02-15T10:00:00Z",
      "2025-02-15T10:30:00Z",
      "2025-02-15T11:00:00Z",
      "2025-02-15T11:30:00Z"
    ]
  }'
```

### Response Format

**Success (200 OK)**:

```typescript
{
  data: {
    conflicts: Array<{
      slot: string;
      existingAppointment: {
        type: string;
        with: string;
        time: string;
      };
    }>;
    outsideAvailability: Array<{
      slot: string;
    }>;
    validSlots: string[];
    subscriptionValidation?: { // Only for subscriptions
      isValid: boolean;
      errors: string[];
      warnings: string[];
      weeklyInfo: Array<{
        weekStart: Date;
        weekEnd: Date;
        existingCalls: number;
        maxCalls: number;
        canScheduleMore: boolean;
        availableSlots: number;
      }>;
      totalCallsScheduled: number;
      maxTotalCalls: number;
      subscriptionPeriod: {
        start: Date;
        end: Date;
      };
    };
  }
}
```

**Example Success Response** (All slots valid):

```json
{
  "data": {
    "conflicts": [],
    "outsideAvailability": [],
    "validSlots": [
      "2025-02-15T10:00:00Z",
      "2025-02-15T10:30:00Z",
      "2025-02-15T11:00:00Z",
      "2025-02-15T11:30:00Z"
    ]
  }
}
```

**Example Success Response** (Partial conflicts):

```json
{
  "data": {
    "conflicts": [
      {
        "slot": "2025-02-15T10:00:00Z",
        "existingAppointment": {
          "type": "Consultation",
          "with": "John Doe",
          "time": "2/15/2025, 10:00:00 AM"
        }
      }
    ],
    "outsideAvailability": [
      {
        "slot": "2025-02-15T11:30:00Z"
      }
    ],
    "validSlots": ["2025-02-15T10:30:00Z", "2025-02-15T11:00:00Z"]
  }
}
```

**Example Success Response** (Subscription with weekly info):

```json
{
  "data": {
    "conflicts": [],
    "outsideAvailability": [],
    "validSlots": ["2025-02-15T10:00:00Z", "2025-02-15T10:30:00Z"],
    "subscriptionValidation": {
      "isValid": true,
      "errors": [],
      "warnings": [],
      "weeklyInfo": [
        {
          "weekStart": "2025-02-09T00:00:00.000Z",
          "weekEnd": "2025-02-15T23:59:59.999Z",
          "existingCalls": 1,
          "maxCalls": 2,
          "canScheduleMore": true,
          "availableSlots": 1
        }
      ],
      "totalCallsScheduled": 5,
      "maxTotalCalls": 10,
      "subscriptionPeriod": {
        "start": "2025-02-01T00:00:00.000Z",
        "end": "2025-04-01T00:00:00.000Z"
      }
    }
  }
}
```

### Error Responses

**400 Bad Request** (Invalid input):

```json
{
  "error": "slots: 'slots' array must contain at least one time slot to validate"
}
```

```json
{
  "error": "slots.0: Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')"
}
```

**404 Not Found** (Event doesn't exist):

```json
{
  "error": "Consultation not found"
}
```

**500 Internal Server Error** (Server error):

```json
{
  "error": "Failed to validate slots"
}
```

---

## Allocate Endpoints

Create appointments by allocating time slots.

### Request Format

**Method**: `PATCH`

**URL Pattern**: `/api/events/{eventType}/{eventId}/allocate`

**Headers**:

```
Content-Type: application/json
Authorization: Bearer {token}
```

**URL Parameters**:

| Parameter   | Type          | Description                                                          | Example                                |
| ----------- | ------------- | -------------------------------------------------------------------- | -------------------------------------- |
| `eventType` | string        | Event type (`consultations`, `subscriptions`, `webinars`, `classes`) | `consultations`                        |
| `eventId`   | string (UUID) | Unique event identifier                                              | `550e8400-e29b-41d4-a716-446655440000` |

**Request Body**:

```typescript
{
  isAuto: boolean;
  useRequestedSlots?: boolean;
  slots?: string[]; // Required for manual allocation
}
```

**Allocation Modes**:

1. **Auto Allocation** (`isAuto: true`)
   - System automatically finds first available slots
   - No `slots` array needed

2. **Manual Allocation** (`isAuto: false`, `slots` provided)
   - User specifies exact slots to allocate
   - Slots must pass all validation

3. **Requested Slots** (`useRequestedSlots: true`)
   - Use slots previously submitted by consultee
   - Only for consultations and subscriptions

**Example Requests**:

**Auto Allocation**:

```bash
curl -X PATCH https://your-domain.com/api/events/consultations/550e8400-e29b-41d4-a716-446655440000/allocate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "isAuto": true
  }'
```

**Manual Allocation**:

```bash
curl -X PATCH https://your-domain.com/api/events/consultations/550e8400-e29b-41d4-a716-446655440000/allocate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "isAuto": false,
    "slots": [
      "2025-02-15T10:00:00Z",
      "2025-02-15T10:30:00Z",
      "2025-02-15T11:00:00Z",
      "2025-02-15T11:30:00Z"
    ]
  }'
```

**Requested Slots**:

```bash
curl -X PATCH https://your-domain.com/api/events/consultations/550e8400-e29b-41d4-a716-446655440000/allocate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "isAuto": false,
    "useRequestedSlots": true
  }'
```

### Response Format

**Success (200 OK)**:

```typescript
{
  data: Array<{
    id: string;
    appointmentType: string;
    consultationId?: string;
    subscriptionId?: string;
    webinarId?: string;
    classId?: string;
    slotsOfAppointment: Array<{
      id: string;
      slotStartTimeInUTC: string;
      slotEndTimeInUTC: string;
      isTentative: boolean;
    }>;
  }>;
  warnings?: string[];
}
```

**Example Success Response** (Consultation):

```json
{
  "data": [
    {
      "id": "app-123",
      "appointmentType": "CONSULTATION",
      "consultationId": "550e8400-e29b-41d4-a716-446655440000",
      "slotsOfAppointment": [
        {
          "id": "slot-1",
          "slotStartTimeInUTC": "2025-02-15T10:00:00.000Z",
          "slotEndTimeInUTC": "2025-02-15T10:30:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-2",
          "slotStartTimeInUTC": "2025-02-15T10:30:00.000Z",
          "slotEndTimeInUTC": "2025-02-15T11:00:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-3",
          "slotStartTimeInUTC": "2025-02-15T11:00:00.000Z",
          "slotEndTimeInUTC": "2025-02-15T11:30:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-4",
          "slotStartTimeInUTC": "2025-02-15T11:30:00.000Z",
          "slotEndTimeInUTC": "2025-02-15T12:00:00.000Z",
          "isTentative": false
        }
      ]
    }
  ],
  "warnings": []
}
```

**Example Success Response** (Subscription with multiple appointments):

```json
{
  "data": [
    {
      "id": "app-201",
      "appointmentType": "SUBSCRIPTION",
      "subscriptionId": "sub-456",
      "slotsOfAppointment": [
        {
          "id": "slot-10",
          "slotStartTimeInUTC": "2025-02-10T10:00:00.000Z",
          "slotEndTimeInUTC": "2025-02-10T10:30:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-11",
          "slotStartTimeInUTC": "2025-02-10T10:30:00.000Z",
          "slotEndTimeInUTC": "2025-02-10T11:00:00.000Z",
          "isTentative": false
        }
      ]
    },
    {
      "id": "app-202",
      "appointmentType": "SUBSCRIPTION",
      "subscriptionId": "sub-456",
      "slotsOfAppointment": [
        {
          "id": "slot-20",
          "slotStartTimeInUTC": "2025-02-17T10:00:00.000Z",
          "slotEndTimeInUTC": "2025-02-17T10:30:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-21",
          "slotStartTimeInUTC": "2025-02-17T10:30:00.000Z",
          "slotEndTimeInUTC": "2025-02-17T11:00:00.000Z",
          "isTentative": false
        }
      ]
    }
  ],
  "warnings": []
}
```

### Error Responses

**400 Bad Request** (Invalid input):

```json
{
  "error": "isAuto: Expected boolean, received string"
}
```

```json
{
  "error": "slots: Manual allocation requires 'slots' array with at least one time slot"
}
```

**404 Not Found** (Event doesn't exist):

```json
{
  "error": "Consultation not found"
}
```

**500 Internal Server Error** (Validation/allocation failed):

```json
{
  "error": "Validation failed: Slot 2/15/2025, 10:00:00 AM already booked (conflicts with consultation for John Doe)"
}
```

```json
{
  "error": "Validation failed: Consultation requires exactly 4 slots (2 hours) but 3 provided"
}
```

```json
{
  "error": "Validation failed: Week of 2/9/2025 exceeds call limit. Maximum 2 calls per week, but 3 calls are scheduled."
}
```

---

## Complete Endpoint Examples

### 1. Consultation Validate

**Request**:

```http
POST /api/events/consultations/550e8400-e29b-41d4-a716-446655440000/validate
Content-Type: application/json

{
  "slots": [
    "2025-02-15T10:00:00Z",
    "2025-02-15T10:30:00Z"
  ]
}
```

**Response** (200 OK):

```json
{
  "data": {
    "conflicts": [],
    "outsideAvailability": [],
    "validSlots": ["2025-02-15T10:00:00Z", "2025-02-15T10:30:00Z"]
  }
}
```

---

### 2. Consultation Allocate (Manual)

**Request**:

```http
PATCH /api/events/consultations/550e8400-e29b-41d4-a716-446655440000/allocate
Content-Type: application/json

{
  "isAuto": false,
  "slots": [
    "2025-02-15T10:00:00Z",
    "2025-02-15T10:30:00Z"
  ]
}
```

**Response** (200 OK):

```json
{
  "data": [
    {
      "id": "app-123",
      "appointmentType": "CONSULTATION",
      "consultationId": "550e8400-e29b-41d4-a716-446655440000",
      "slotsOfAppointment": [
        {
          "id": "slot-1",
          "slotStartTimeInUTC": "2025-02-15T10:00:00.000Z",
          "slotEndTimeInUTC": "2025-02-15T10:30:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-2",
          "slotStartTimeInUTC": "2025-02-15T10:30:00.000Z",
          "slotEndTimeInUTC": "2025-02-15T11:00:00.000Z",
          "isTentative": false
        }
      ]
    }
  ],
  "warnings": []
}
```

---

### 3. Subscription Validate (with weekly limits)

**Request**:

```http
POST /api/events/subscriptions/sub-456/validate
Content-Type: application/json

{
  "slots": [
    "2025-02-10T10:00:00Z",
    "2025-02-10T10:30:00Z",
    "2025-02-10T11:00:00Z",
    "2025-02-12T14:00:00Z",
    "2025-02-12T14:30:00Z",
    "2025-02-12T15:00:00Z"
  ]
}
```

**Response** (200 OK):

```json
{
  "data": {
    "conflicts": [],
    "outsideAvailability": [],
    "validSlots": [
      "2025-02-10T10:00:00Z",
      "2025-02-10T10:30:00Z",
      "2025-02-10T11:00:00Z",
      "2025-02-12T14:00:00Z",
      "2025-02-12T14:30:00Z",
      "2025-02-12T15:00:00Z"
    ],
    "subscriptionValidation": {
      "isValid": true,
      "errors": [],
      "warnings": [],
      "weeklyInfo": [
        {
          "weekStart": "2025-02-09T00:00:00.000Z",
          "weekEnd": "2025-02-15T23:59:59.999Z",
          "existingCalls": 2,
          "maxCalls": 2,
          "canScheduleMore": false,
          "availableSlots": 0
        }
      ],
      "totalCallsScheduled": 2,
      "maxTotalCalls": 10,
      "subscriptionPeriod": {
        "start": "2025-02-01T00:00:00.000Z",
        "end": "2025-04-01T00:00:00.000Z"
      }
    }
  }
}
```

---

### 4. Subscription Allocate (Auto)

**Request**:

```http
PATCH /api/events/subscriptions/sub-456/allocate
Content-Type: application/json

{
  "isAuto": true
}
```

**Response** (200 OK):

```json
{
  "data": [
    {
      "id": "app-301",
      "appointmentType": "SUBSCRIPTION",
      "subscriptionId": "sub-456",
      "slotsOfAppointment": [
        {
          "id": "slot-301",
          "slotStartTimeInUTC": "2025-02-10T09:00:00.000Z",
          "slotEndTimeInUTC": "2025-02-10T09:30:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-302",
          "slotStartTimeInUTC": "2025-02-10T09:30:00.000Z",
          "slotEndTimeInUTC": "2025-02-10T10:00:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-303",
          "slotStartTimeInUTC": "2025-02-10T10:00:00.000Z",
          "slotEndTimeInUTC": "2025-02-10T10:30:00.000Z",
          "isTentative": false
        }
      ]
    }
  ],
  "warnings": []
}
```

---

### 5. Webinar Allocate (Manual)

**Request**:

```http
PATCH /api/events/webinars/web-789/allocate
Content-Type: application/json

{
  "isAuto": false,
  "slots": [
    "2025-03-20T18:00:00Z",
    "2025-03-20T18:30:00Z",
    "2025-03-20T19:00:00Z",
    "2025-03-20T19:30:00Z"
  ]
}
```

**Response** (200 OK):

```json
{
  "data": [
    {
      "id": "app-401",
      "appointmentType": "WEBINAR",
      "webinarId": "web-789",
      "slotsOfAppointment": [
        {
          "id": "slot-401",
          "slotStartTimeInUTC": "2025-03-20T18:00:00.000Z",
          "slotEndTimeInUTC": "2025-03-20T18:30:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-402",
          "slotStartTimeInUTC": "2025-03-20T18:30:00.000Z",
          "slotEndTimeInUTC": "2025-03-20T19:00:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-403",
          "slotStartTimeInUTC": "2025-03-20T19:00:00.000Z",
          "slotEndTimeInUTC": "2025-03-20T19:30:00.000Z",
          "isTentative": false
        },
        {
          "id": "slot-404",
          "slotStartTimeInUTC": "2025-03-20T19:30:00.000Z",
          "slotEndTimeInUTC": "2025-03-20T20:00:00.000Z",
          "isTentative": false
        }
      ]
    }
  ],
  "warnings": []
}
```

---

### 6. Class Validate (with session grouping)

**Request**:

```http
POST /api/events/classes/class-101/validate
Content-Type: application/json

{
  "slots": [
    "2025-02-03T10:00:00Z",
    "2025-02-03T10:30:00Z",
    "2025-02-03T11:00:00Z",
    "2025-02-03T11:30:00Z",
    "2025-02-05T10:00:00Z",
    "2025-02-05T10:30:00Z",
    "2025-02-05T11:00:00Z",
    "2025-02-05T11:30:00Z"
  ]
}
```

**Response** (200 OK):

```json
{
  "data": {
    "conflicts": [],
    "outsideAvailability": [],
    "validSlots": [
      "2025-02-03T10:00:00Z",
      "2025-02-03T10:30:00Z",
      "2025-02-03T11:00:00Z",
      "2025-02-03T11:30:00Z",
      "2025-02-05T10:00:00Z",
      "2025-02-05T10:30:00Z",
      "2025-02-05T11:00:00Z",
      "2025-02-05T11:30:00Z"
    ]
  }
}
```

---

## Error Code Summary

| Status Code | Meaning               | Common Causes                                                        |
| ----------- | --------------------- | -------------------------------------------------------------------- |
| **200**     | Success               | Request completed successfully                                       |
| **400**     | Bad Request           | Invalid input format, missing required fields, Zod validation failed |
| **404**     | Not Found             | Event ID doesn't exist                                               |
| **500**     | Internal Server Error | Validation failed, allocation failed, database error                 |

---

## Common Error Scenarios

### 1. Invalid Event ID

**Request**:

```http
POST /api/events/consultations/invalid-uuid/validate
```

**Response** (400):

```json
{
  "error": "Event ID must be a valid UUID format"
}
```

---

### 2. Missing Slots Array

**Request**:

```http
POST /api/events/consultations/550e8400-e29b-41d4-a716-446655440000/validate
Content-Type: application/json

{}
```

**Response** (400):

```json
{
  "error": "slots: 'slots' array must contain at least one time slot to validate"
}
```

---

### 3. Invalid Datetime Format

**Request**:

```http
POST /api/events/consultations/550e8400-e29b-41d4-a716-446655440000/validate
Content-Type: application/json

{
  "slots": ["2025-02-15"]
}
```

**Response** (400):

```json
{
  "error": "slots.0: Each slot must be a valid ISO 8601 datetime string (e.g., '2025-01-15T10:00:00Z')"
}
```

---

### 4. Manual Allocation Without Slots

**Request**:

```http
PATCH /api/events/consultations/550e8400-e29b-41d4-a716-446655440000/allocate
Content-Type: application/json

{
  "isAuto": false
}
```

**Response** (400):

```json
{
  "error": "slots: Manual allocation requires 'slots' array with at least one time slot"
}
```

---

### 5. Slot Already Booked

**Request**:

```http
PATCH /api/events/consultations/550e8400-e29b-41d4-a716-446655440000/allocate
Content-Type: application/json

{
  "isAuto": false,
  "slots": ["2025-02-15T10:00:00Z", "2025-02-15T10:30:00Z"]
}
```

**Response** (500):

```json
{
  "error": "Validation failed: Slot already booked: 2/15/2025, 10:00:00 AM (conflicts with consultation for John Doe)"
}
```

---

### 6. Incorrect Slot Count

**Request** (Consultation requires 4 slots but only 3 provided):

```http
PATCH /api/events/consultations/550e8400-e29b-41d4-a716-446655440000/allocate
Content-Type: application/json

{
  "isAuto": false,
  "slots": [
    "2025-02-15T10:00:00Z",
    "2025-02-15T10:30:00Z",
    "2025-02-15T11:00:00Z"
  ]
}
```

**Response** (500):

```json
{
  "error": "Validation failed: Consultation requires exactly 4 slots (2 hours) but 3 provided"
}
```

---

### 7. Weekly Limit Exceeded

**Request** (Subscription allows 2 calls/week but 3 scheduled):

```http
PATCH /api/events/subscriptions/sub-456/allocate
Content-Type: application/json

{
  "isAuto": false,
  "slots": [
    "2025-02-10T10:00:00Z",
    "2025-02-10T10:30:00Z",
    "2025-02-12T14:00:00Z",
    "2025-02-12T14:30:00Z",
    "2025-02-14T16:00:00Z",
    "2025-02-14T16:30:00Z"
  ]
}
```

**Response** (500):

```json
{
  "error": "Validation failed: Week of 2/9/2025 exceeds call limit. Maximum 2 calls per week, but 3 calls are scheduled."
}
```

---

### 8. Slots Not Consecutive

**Request**:

```http
PATCH /api/events/consultations/550e8400-e29b-41d4-a716-446655440000/allocate
Content-Type: application/json

{
  "isAuto": false,
  "slots": [
    "2025-02-15T10:00:00Z",
    "2025-02-15T11:00:00Z"
  ]
}
```

**Response** (500):

```json
{
  "error": "Validation failed: Consultation slots must be consecutive (no gaps allowed)"
}
```

---

## Integration Examples

### JavaScript/TypeScript (fetch)

```typescript
// Validate slots
async function validateSlots(
  eventType: string,
  eventId: string,
  slots: string[],
) {
  const response = await fetch(`/api/events/${eventType}/${eventId}/validate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ slots }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const data = await response.json();
  return data.data;
}

// Allocate slots
async function allocateSlots(
  eventType: string,
  eventId: string,
  isAuto: boolean,
  slots?: string[],
) {
  const response = await fetch(`/api/events/${eventType}/${eventId}/allocate`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ isAuto, slots }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const data = await response.json();
  return data.data;
}

// Usage
try {
  // Validate first
  const validation = await validateSlots(
    "consultations",
    "550e8400-e29b-41d4-a716-446655440000",
    ["2025-02-15T10:00:00Z", "2025-02-15T10:30:00Z"],
  );

  if (validation.validSlots.length === 2) {
    // All slots valid, proceed to allocate
    const appointments = await allocateSlots(
      "consultations",
      "550e8400-e29b-41d4-a716-446655440000",
      false,
      ["2025-02-15T10:00:00Z", "2025-02-15T10:30:00Z"],
    );
    console.log("Appointments created:", appointments);
  } else {
    console.error("Some slots invalid:", validation.conflicts);
  }
} catch (error) {
  console.error("API error:", error.message);
}
```

### Python (requests)

```python
import requests

BASE_URL = "https://your-domain.com"
TOKEN = "your-token"

def validate_slots(event_type, event_id, slots):
    response = requests.post(
        f"{BASE_URL}/api/events/{event_type}/{event_id}/validate",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        json={"slots": slots},
    )
    response.raise_for_status()
    return response.json()["data"]

def allocate_slots(event_type, event_id, is_auto, slots=None):
    response = requests.patch(
        f"{BASE_URL}/api/events/{event_type}/{event_id}/allocate",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {TOKEN}",
        },
        json={"isAuto": is_auto, "slots": slots},
    )
    response.raise_for_status()
    return response.json()["data"]

# Usage
try:
    validation = validate_slots(
        "consultations",
        "550e8400-e29b-41d4-a716-446655440000",
        ["2025-02-15T10:00:00Z", "2025-02-15T10:30:00Z"],
    )

    if len(validation["validSlots"]) == 2:
        appointments = allocate_slots(
            "consultations",
            "550e8400-e29b-41d4-a716-446655440000",
            False,
            ["2025-02-15T10:00:00Z", "2025-02-15T10:30:00Z"],
        )
        print(f"Appointments created: {appointments}")
    else:
        print(f"Some slots invalid: {validation['conflicts']}")
except requests.HTTPError as e:
    print(f"API error: {e.response.json()['error']}")
```

---

## Rate Limiting

**Not currently implemented**, but recommended for production:

- **Validate endpoints**: 60 requests/minute per user
- **Allocate endpoints**: 30 requests/minute per user

---

## Best Practices

1. **Always validate before allocating**: Call validate endpoint first to check for conflicts
2. **Handle partial validation**: Some slots may be valid while others conflict
3. **Use ISO 8601 format**: Always send datetimes as `YYYY-MM-DDTHH:MM:SSZ`
4. **Check response status**: Don't assume 200 OK, check for errors
5. **Display validation errors**: Show users which specific slots have issues
6. **Retry on 500**: Server errors may be transient, retry with exponential backoff
7. **Cache consultant availability**: Reduce validate calls by client-side filtering

---

## Next Steps

- **Event Types**: See `03_EVENT_TYPES.md` for event-specific rules
- **Validation**: See `04_VALIDATION_LAYERS.md` for validation architecture
- **Troubleshooting**: See `08_TROUBLESHOOTING.md` for common API errors
- **Testing**: See `09_TESTING_GUIDE.md` for API testing strategies
