---
type: reference
title: Familiarise — Schema map, Bookings & Appointments
---

# Schema map — Bookings & Appointments

The request-to-payment chain, and the appointment every booking resolves to.

Part 3 of 10 of the domain map. The
[map index](../00-schema-map.md) holds the master diagram, the enforcer
inventory and the enum reference.

## 1. One-to-One Bookings

The request-to-approval-to-payment chain for one-to-one services. `Consultation` and `Subscription` are the bookings; `Trial` is a time-boxed free or discounted first session that can convert into a `Subscription`. `ActivityLog` is the generic per-user activity feed.

```mermaid
erDiagram
    Consultation {
        id string PK
        status appointmentstatus
        consultationPlanId string FK
        requestedById string FK
        cancelledBy string FK
        createdAt datetime
    }
    Subscription {
        id string PK
        status appointmentstatus
        sessionsTotal int
        requestedById string FK
        cancelledBy string FK
        subscriptionPlanId string FK
    }
    Trial {
        id string PK
        status trialstatus
        consulteeProfileId string FK
        consultantProfileId string FK
        subscriptionPlanId string FK
        appointmentId string FK
    }
    ActivityLog {
        id string PK
        consultantProfileId string FK
        createdAt datetime
        activityType activitytype
        description string
        metadata json
    }
    User {
        id string PK
    }
    ConsultantProfile {
        id string PK
    }
    ConsultationPlan {
        id string PK
    }
    SubscriptionPlan {
        id string PK
    }
    Payment {
        id string PK
    }
    Consultation }o--|| ConsultationPlan : "consultationPlan"
    Consultation }o--o| User : "cancelledByUser"
    Subscription }o--o| User : "cancelledByUser"
    Subscription }o--|| SubscriptionPlan : "subscriptionPlan"
    Subscription }o--o| Subscription : "renewedFrom"
    Trial }o--|| ConsultantProfile : "consultantProfile"
    Trial }o--|| SubscriptionPlan : "subscriptionPlan"
    Trial }o--o| Payment : "payment"
    Trial }o--o| Subscription : "convertedToSubscription"
    ActivityLog }o--|| ConsultantProfile : "consultantProfile"
    ConsultantProfile }o--|| User : "user"
    ConsultationPlan }o--|| ConsultantProfile : "consultantProfile"
    SubscriptionPlan }o--|| ConsultantProfile : "consultantProfile"
    Payment }o--|| User : "user"
    Payment }o--o| Payment : "parentPayment"
```

- **Every booking row is a request first and a payment second.** `pendingPaymentUrl` is written before money moves, and the booking only becomes confirmed when the payment confirmation pipeline says so.
- **A trial that converts leaves a pointer, it does not mutate.** `Trial.convertedToSubscriptionId` is the one-way link, so the trial's own history stays intact for the refund and tax trail.

## 2. Group Bookings — Webinar & Class

A webinar is one session with many registrants; a class is a cohort that runs over many sessions. In both cases the registrants share a single `Appointment` row, which is what makes a group event cheap to fan out and hard to over-book: capacity is checked against the appointment's participants, not against a per-registrant row.

```mermaid
erDiagram
    Webinar {
        id string PK
        status webinarstatus
        webinarPlanId string FK
        createdAt datetime
        feedbackSummary string
        chatFrozenAt datetime
    }
    ClassBatch {
        id string PK
        status classstatus
        classPlanId string FK
        createdAt datetime
        schedulingPeriodStartsAt datetime
        schedulingPeriodEndsAt datetime
    }
    User {
        id string PK
    }
    ConsultantProfile {
        id string PK
    }
    WebinarPlan {
        id string PK
    }
    ClassPlan {
        id string PK
    }
    Appointment {
        id string PK
    }
    Webinar }o--|| WebinarPlan : "webinarPlan"
    ClassBatch }o--|| ClassPlan : "classPlan"
    ConsultantProfile }o--|| User : "user"
    WebinarPlan }o--o| ConsultantProfile : "consultantProfile"
    ClassPlan }o--o| ConsultantProfile : "consultantProfile"
    Appointment }o--o| Webinar : "webinar"
    Appointment }o--o| ClassBatch : "class"
```

- **`maxParticipants` is a per-instance override.** A null on `Webinar` or `Class` inherits the plan's value; the per-instance value is what the capacity check reads.

## 3. Appointment — The Pivot Model

`Appointment` is the pivot that every booking type resolves to. A one-to-one consultation has exactly one; a subscription has one per session; a webinar has one shared by all registrants; a class has one per session; a trial has one. `AppointmentOccurrence` is a concrete time slot inside it, `AppointmentParticipant` is the per-person seat row, and `BookingStatusHistory` is the append-only record of every status transition.

```mermaid
erDiagram
    Appointment {
        id string PK
        cancellationPolicyId string FK
        consultationId string FK
        subscriptionId string FK
        webinarId string FK
        classId string FK
    }
    AppointmentParticipant {
        id string PK
        status participantstatus
        role participantrole
        appointmentId string FK
        userId string FK
        paymentId string FK
    }
    AppointmentOccurrence {
        id string PK
        appointmentId string FK
        createdAt datetime
        ordinal int
        startsAt datetime
        endsAt datetime
    }
    BookingStatusHistory {
        id string PK
        appointmentId string FK
        actorUserId string FK
        organizationId string FK
        createdAt datetime
        entity bookinghistoryentity
    }
    User {
        id string PK
    }
    Consultation {
        id string PK
    }
    Subscription {
        id string PK
    }
    Webinar {
        id string PK
    }
    ClassBatch {
        id string PK
    }
    Appointment }o--o| Consultation : "consultation"
    Appointment }o--o| Subscription : "subscription"
    Appointment }o--o| Webinar : "webinar"
    Appointment }o--o| ClassBatch : "class"
    AppointmentParticipant }o--|| Appointment : "appointment"
    AppointmentParticipant }o--|| User : "user"
    AppointmentOccurrence }o--|| Appointment : "appointment"
    BookingStatusHistory }o--o| Appointment : "appointment"
    BookingStatusHistory }o--o| User : "actorUser"
    Consultation }o--o| User : "cancelledByUser"
    Subscription }o--o| User : "cancelledByUser"
    Subscription }o--o| Subscription : "renewedFrom"
```

- **`BookingStatusHistory` is immutable and enforced as such.** `booking_status_history_immutable` in `prisma/sql/check-constraints.sql` refuses an update or delete, so the transition history is a ledger rather than a log.
- **An occurrence may be tentative.** A tentative occurrence holds its time but is not a confirmed booking, which is why `occurrence_no_confirmed_overlap` deliberately ignores tentative rows — the app-enforced slot lock covers that window instead.
