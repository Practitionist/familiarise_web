# Collaborator System — API Reference

All endpoints require authentication (via BetterAuth session).

---

## Collaborator Management

### GET /api/webinars/[webinarPlanId]/collaborators

List all collaborators for a webinar plan.

**Response** `200`:
```json
{
  "data": [
    {
      "id": "clx...",
      "consultantProfileId": "clx...",
      "webinarPlanId": "clx...",
      "role": "CO_HOST",
      "revenueSharePercentage": 25,
      "status": "ACCEPTED",
      "invitedById": "clx...",
      "respondedAt": "2026-02-10T...",
      "consultantProfile": {
        "id": "clx...",
        "user": {
          "id": "clx...",
          "name": "Alice Smith",
          "image": "/uploads/alice.jpg"
        }
      }
    }
  ]
}
```

---

### POST /api/webinars/[webinarPlanId]/collaborators

Invite a collaborator to a webinar plan.

**Body**:
```json
{
  "consultantProfileId": "clx...",
  "role": "CO_HOST",
  "revenueSharePercentage": 25
}
```

**Validations**:
- Requester must be the plan owner
- Target must be a valid consultant profile
- Cannot invite yourself
- Cannot invite someone already invited (unique constraint)
- Total collaborator shares must not exceed 90%

**Response** `201`:
```json
{
  "data": {
    "id": "clx...",
    "consultantProfileId": "clx...",
    "role": "CO_HOST",
    "revenueSharePercentage": 25,
    "status": "PENDING"
  }
}
```

**Errors**:
- `403` — Not the plan owner
- `400` — Cannot invite yourself
- `400` — Revenue share exceeds 90% total
- `409` — Already invited (unique constraint)

---

### PATCH /api/webinars/[webinarPlanId]/collaborators/[id]

Update a collaborator's role or revenue share.

**Body**:
```json
{
  "role": "MODERATOR",
  "revenueSharePercentage": 15
}
```

**Validations**:
- Requester must be the plan owner
- New total shares must not exceed 90%

**Response** `200`:
```json
{
  "data": { "id": "clx...", "role": "MODERATOR", "revenueSharePercentage": 15 }
}
```

---

### DELETE /api/webinars/[webinarPlanId]/collaborators/[id]

Remove a collaborator (sets status to REMOVED).

**Validations**:
- Requester must be the plan owner

**Response** `200`:
```json
{
  "data": { "id": "clx...", "status": "REMOVED" }
}
```

---

### Class Collaborator Endpoints

Identical to the webinar endpoints above, but at:

- `GET /api/classes/[classPlanId]/collaborators`
- `POST /api/classes/[classPlanId]/collaborators`
- `PATCH /api/classes/[classPlanId]/collaborators/[id]`
- `DELETE /api/classes/[classPlanId]/collaborators/[id]`

Same request/response shapes. Uses `ClassCollaboratorRole` enum values:
`CO_INSTRUCTOR`, `TEACHING_ASSISTANT`, `GUEST_LECTURER`, `CONTENT_CREATOR`

---

## Invitation Response

### PATCH /api/collaborations/[id]/respond

Accept or decline a collaboration invitation.

**Body**:
```json
{
  "response": "ACCEPTED",
  "planType": "webinar"
}
```

**Validations**:
- Requester must be the invited consultant
- Collaboration must be in PENDING status
- `planType` must be `"webinar"` or `"class"`

**Side effects on ACCEPTED**:
- Updates status to ACCEPTED, sets respondedAt
- Creates Stream.io chat channel (`collab-{planType}-{planId}`)
- Sends notification to the host

**Response** `200`:
```json
{
  "data": { "id": "clx...", "status": "ACCEPTED", "respondedAt": "2026-02-10T..." }
}
```

---

## My Collaborations

### GET /api/collaborations

Get all collaborations for the authenticated consultant (both webinar and class).

**Response** `200`:
```json
{
  "data": {
    "webinarCollaborations": [
      {
        "id": "clx...",
        "role": "CO_HOST",
        "revenueSharePercentage": 25,
        "status": "PENDING",
        "createdAt": "2026-02-10T...",
        "webinarPlan": {
          "id": "clx...",
          "title": "Advanced React Patterns",
          "price": 100000
        },
        "invitedBy": {
          "user": { "name": "Kaustav Ghosh" }
        }
      }
    ],
    "classCollaborations": [
      {
        "id": "clx...",
        "role": "TEACHING_ASSISTANT",
        "revenueSharePercentage": 15,
        "status": "ACCEPTED",
        "createdAt": "2026-02-08T...",
        "classPlan": {
          "id": "clx...",
          "title": "Full-Stack Bootcamp",
          "price": 500000
        },
        "invitedBy": {
          "user": { "name": "Alice Smith" }
        }
      }
    ]
  }
}
```

---

## Revenue Split Preview

### GET /api/webinars/[id]/revenue-split

Preview how earnings would be split for a webinar plan.

**Response** `200`:
```json
{
  "data": {
    "planId": "clx...",
    "planType": "webinar",
    "price": 100000,
    "splits": [
      {
        "consultantProfileId": "clx...",
        "role": "OWNER",
        "sharePercentage": 60,
        "grossAmount": 60000,
        "platformFee": 12000,
        "netAmount": 48000
      },
      {
        "consultantProfileId": "clx...",
        "role": "COLLABORATOR",
        "sharePercentage": 25,
        "grossAmount": 25000,
        "platformFee": 5000,
        "netAmount": 20000
      },
      {
        "consultantProfileId": "clx...",
        "role": "COLLABORATOR",
        "sharePercentage": 15,
        "grossAmount": 15000,
        "platformFee": 3000,
        "netAmount": 12000
      }
    ]
  }
}
```

### GET /api/classes/[id]/revenue-split

Same format for class plans.

---

## Co-host Availability

### GET /api/collaborators/[consultantProfileId]/availability

Get a collaborator's availability for a specific date. Used by the host's scheduling calendar to show availability overlay.

**Query params**:
- `date` — ISO date string (e.g. `2026-03-15`)

**Response** `200`:
```json
{
  "data": {
    "consultantProfileId": "clx...",
    "scheduleType": "WEEKLY",
    "date": "2026-03-15",
    "weeklySlots": [
      {
        "dayOfWeekForStartsAt": 6,
        "availabilityStartsAt": "2026-02-10T09:00:00Z",
        "availabilityEndsAt": "2026-02-10T17:00:00Z"
      }
    ],
    "customSlots": [],
    "bookedSlots": [
      {
        "startsAt": "2026-03-15T10:00:00Z",
        "endsAt": "2026-03-15T11:00:00Z"
      }
    ]
  }
}
```

**Interpretation for calendar overlay**:
- **Green**: Co-host has availability AND no booking → free
- **Yellow**: Co-host has no availability defined for that time → may be flexible
- **Red**: Co-host has a booking during that time → not available
