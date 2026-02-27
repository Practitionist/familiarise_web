# Collaborator System

**Status**: Implemented (Feb 2026)
**Branch**: `feat/referral-collaborator-system`
**Scope**: Webinars and Classes only

## Overview

The collaborator system enables multi-creator content on the Familiarise platform. A consultant (the "host") who owns a webinar or class plan can invite other consultants to collaborate with defined roles and revenue shares. Collaborators can accept or decline invitations, and when participants pay for the service, earnings are automatically split among all collaborators.

### Goals

- Enable team-taught webinars and classes
- Fair, transparent revenue sharing with per-collaborator splits
- Automated earnings distribution on payment success
- Private communication channels for collaborator coordination
- Co-host availability visibility for scheduling

### Key Design Decisions

| Decision               | Choice                                      | Rationale                                                   |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| Scope                  | Webinars + Classes only                     | Podcasts model doesn't exist yet                            |
| Scheduling             | Host-only                                   | Simplicity — only the owner creates events and sets timings |
| Revenue split          | Host sets it, collaborator accepts/declines | Owner controls the deal                                     |
| Minimum host share     | 10%                                         | Prevents giving away entire revenue                         |
| Max collaborator total | 90%                                         | Enforced at invite time                                     |
| Platform fee           | Applied per share independently             | Each collaborator's share is subject to 20% platform fee    |
| Permissions            | Role-based with optional JSON override      | Flexible without complexity                                 |
| Chat channels          | Auto-created on acceptance                  | Collaborators need a place to coordinate                    |
| Video roles            | Deferred                                    | Calls are created client-side; needs deeper changes         |

---

## Architecture

### Data Model

```
ConsultantProfile ──────────────────────────────────────────────┐
  │                                                              │
  │ owns                                                         │ collaborates on
  │                                                              │
  ▼                                                              │
┌──────────────┐     1:many      ┌─────────────────────────┐    │
│ WebinarPlan  │────────────────>│ WebinarCollaborator      │<───┘
│              │                 │                          │
│ title        │                 │ consultantProfileId      │
│ price        │                 │ webinarPlanId            │
│ ...          │                 │ role                     │
└──────────────┘                 │ revenueSharePercentage   │
                                 │ status                   │
                                 │ invitedById              │
                                 │ permissions (JSON)       │
                                 └─────────────────────────┘

┌──────────────┐     1:many      ┌─────────────────────────┐
│ ClassPlan    │────────────────>│ ClassCollaborator        │<───┐
│              │                 │                          │    │
│ title        │                 │ consultantProfileId      │    │
│ price        │                 │ classPlanId              │    │
│ ...          │                 │ role                     │    │
└──────────────┘                 │ revenueSharePercentage   │    │
                                 │ status                   │    │
                                 │ invitedById              │    │
                                 │ permissions (JSON)       │    │
                                 └─────────────────────────┘    │
                                                                 │
ConsultantProfile ───────────────────────────────────────────────┘
```

### Earnings Split Model

```
                        Payment (₹1000)
                             │
                             ▼
                    ┌──────────────────┐
                    │ Split Calculator │
                    │                  │
                    │ Host: 60%        │
                    │ Collab A: 25%    │
                    │ Collab B: 15%    │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
    ┌────────────────┐ ┌──────────────┐ ┌──────────────┐
    │ ConsultantEarnings │ ConsultantEarnings │ ConsultantEarnings │
    │                │ │              │ │              │
    │ role: OWNER    │ │ role: COLLAB │ │ role: COLLAB │
    │ share: 60%     │ │ share: 25%   │ │ share: 15%   │
    │ gross: 600     │ │ gross: 250   │ │ gross: 150   │
    │ fee: 120 (20%) │ │ fee: 50(20%) │ │ fee: 30(20%) │
    │ net: 480       │ │ net: 200     │ │ net: 120     │
    └────────────────┘ └──────────────┘ └──────────────┘
```

---

### Models

**WebinarCollaborator**

| Field                    | Type                    | Description                                          |
| ------------------------ | ----------------------- | ---------------------------------------------------- |
| `id`                     | String                  | Primary key (cuid)                                   |
| `consultantProfileId`    | String                  | The collaborator's profile                           |
| `webinarPlanId`          | String                  | The webinar plan                                     |
| `role`                   | WebinarCollaboratorRole | CO_HOST, MODERATOR, GUEST_SPEAKER, TECHNICAL_SUPPORT |
| `permissions`            | Json?                   | Optional permission overrides                        |
| `revenueSharePercentage` | Float                   | Collaborator's share (e.g. 25.0)                     |
| `status`                 | CollaboratorStatus      | PENDING, ACCEPTED, DECLINED, REMOVED                 |
| `invitedById`            | String                  | The host who sent the invitation                     |
| `respondedAt`            | DateTime?               | When the collaborator responded                      |

Unique constraint: `@@unique([consultantProfileId, webinarPlanId])` — a consultant can only be invited once per plan.

**ClassCollaborator** — Same structure with `classPlanId` and `ClassCollaboratorRole`.

**ConsultantEarnings** (modified)

| Field             | Type        | Description                                      |
| ----------------- | ----------- | ------------------------------------------------ |
| `role`            | EarningRole | `OWNER` or `COLLABORATOR`                        |
| `sharePercentage` | Float       | The share this earning represents (e.g. 60.0)    |
| `paymentId`       | String      | No longer unique — multiple earnings per payment |

### Enums

```
CollaboratorStatus:
  PENDING   — Invitation sent, awaiting response
  ACCEPTED  — Collaborator accepted the invitation
  DECLINED  — Collaborator declined
  REMOVED   — Host removed the collaborator

WebinarCollaboratorRole:
  CO_HOST            — Full co-host capabilities
  MODERATOR          — Chat/audience management
  GUEST_SPEAKER      — Presenting role
  TECHNICAL_SUPPORT  — Behind-the-scenes support

ClassCollaboratorRole:
  CO_INSTRUCTOR       — Full teaching capabilities
  TEACHING_ASSISTANT  — Support role
  GUEST_LECTURER      — Single-session guest
  CONTENT_CREATOR     — Creates materials, may not teach live

EarningRole:
  OWNER        — The plan owner's earnings
  COLLABORATOR — A collaborator's share of earnings
```

---

## File Map

| File                                                                | Purpose                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `lib/collaborators/service.ts`                                      | Core business logic (invite, respond, remove, revenue split) |
| `lib/collaborators/permissions.ts`                                  | Role-based permission checking                               |
| `lib/payments/payouts/earnings-service.ts`                          | `createCollaboratorEarnings()` function                      |
| `app/api/collaborations/webinar/[planId]/route.ts`                  | GET/POST webinar collaborators                               |
| `app/api/collaborations/webinar/[planId]/[id]/route.ts`             | PATCH/DELETE specific webinar collaborator                   |
| `app/api/collaborations/class/[planId]/route.ts`                    | GET/POST class collaborators                                 |
| `app/api/collaborations/class/[planId]/[id]/route.ts`               | PATCH/DELETE specific class collaborator                     |
| `app/api/collaborations/[id]/respond/route.ts`                      | PATCH accept/decline invitation                              |
| `app/api/collaborations/route.ts`                                   | GET all my collaborations                                    |
| `app/api/collaborations/webinar/[planId]/revenue-split/route.ts`    | GET webinar revenue split preview                            |
| `app/api/collaborations/class/[planId]/revenue-split/route.ts`      | GET class revenue split preview                              |
| `app/api/collaborators/[consultantProfileId]/availability/route.ts` | GET co-host availability                                     |
| `components/collaborators/CollaboratorsTab.tsx`                     | Reusable UI for managing collaborators                       |
| `components/collaborators/InvitationsPanel.tsx`                     | Invitation management UI                                     |
| `app/dashboard/consultant/.../collaborations/page.tsx`              | Dashboard page                                               |
| `actions/stream/chat/channel.action.ts`                             | `createCollaboratorChannel()`                                |
| `prisma/seedFiles/14b-create-collaborators.ts`                      | Seed data                                                    |

---

## Related Docs

- [01 — Architecture & Flows](./01-architecture.md)
- [02 — API Reference](./02-api-reference.md)
- [03 — Revenue Sharing](./03-revenue-sharing.md)
- [04 — Permissions](./04-permissions.md)
- [05 — Stream Integration](./05-stream-integration.md)
