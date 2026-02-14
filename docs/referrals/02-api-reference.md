# Referral System — API Reference

All endpoints require authentication (via BetterAuth session) unless marked **Public**.

Base URL: `/api/referrals`

---

## Endpoints

### GET /api/referrals/code

Get the authenticated user's referral code.

**Auth**: Required

**Response** `200`:
```json
{
  "data": {
    "id": "clx...",
    "userId": "clx...",
    "code": "kaustavga3x7",
    "customCode": "kaustav",
    "referrerReward": 50000,
    "refereeReward": 20000,
    "totalReferrals": 5,
    "successfulReferrals": 2,
    "totalEarned": 100000,
    "isActive": true,
    "createdAt": "2026-02-10T..."
  }
}
```

**Response** `404`:
```json
{ "error": "No referral code found" }
```

---

### POST /api/referrals/code

Create a referral code for the authenticated user (or return existing one).

**Auth**: Required

**Body**: Empty (no body required)

**Response** `200`:
```json
{
  "data": {
    "id": "clx...",
    "code": "kaustavga3x7",
    "customCode": null,
    "referrerReward": 50000,
    "refereeReward": 20000,
    "totalReferrals": 0,
    "successfulReferrals": 0,
    "totalEarned": 0,
    "isActive": true
  }
}
```

---

### POST /api/referrals/code/customize

Set a vanity code for the authenticated user.

**Auth**: Required

**Body**:
```json
{ "customCode": "kaustav" }
```

**Validation**:
- 3-20 characters
- Alphanumeric only (`/^[a-z0-9]+$/`)
- Must not already exist as a `code` or `customCode` in the database

**Response** `200`:
```json
{
  "data": {
    "id": "clx...",
    "code": "kaustavga3x7",
    "customCode": "kaustav"
  }
}
```

**Error** `400`:
```json
{ "error": "Custom code must be 3-20 alphanumeric characters" }
```

**Error** `409`:
```json
{ "error": "This code is already taken" }
```

---

### GET /api/referrals/code/check/[code]  (Public)

Validate a referral code without authentication. Used on the signup page.

**Auth**: Not required

**Params**: `code` — The referral code to validate

**Response** `200`:
```json
{
  "data": {
    "valid": true,
    "referrerName": "Kaustav Ghosh",
    "refereeReward": 20000
  }
}
```

Invalid code:
```json
{
  "data": {
    "valid": false,
    "referrerName": null,
    "refereeReward": 0
  }
}
```

---

### GET /api/referrals

List the authenticated user's referrals (people they referred).

**Auth**: Required

**Response** `200`:
```json
{
  "data": [
    {
      "id": "clx...",
      "referredUserId": "clx...",
      "status": "REWARDED",
      "referrerRewardAmount": 50000,
      "refereeRewardAmount": 20000,
      "signedUpAt": "2026-02-01T...",
      "qualifiedAt": "2026-02-05T...",
      "qualifyingAction": "first_paid_booking",
      "referredUser": {
        "name": "Alice Smith",
        "image": "/uploads/alice.jpg"
      }
    }
  ]
}
```

---

### POST /api/referrals/apply

Apply a referral code to the authenticated (newly signed-up) user.

**Auth**: Required

**Body**:
```json
{ "code": "kaustavga3x7" }
```

**Validations**:
1. Code exists and is active
2. User is not referring themselves
3. User hasn't already been referred (referredUserId is unique)

**Response** `200`:
```json
{ "data": { "success": true } }
```

**Error** `400`:
```json
{ "error": "Invalid referral code" }
```
```json
{ "error": "You cannot refer yourself" }
```
```json
{ "error": "You have already been referred" }
```

---

### GET /api/referrals/credits

Get the authenticated user's full credit history and total available balance.

**Auth**: Required

**Response** `200`:
```json
{
  "data": {
    "totalAvailable": 70000,
    "credits": [
      {
        "id": "clx...",
        "amount": 50000,
        "currency": "INR",
        "source": "REFERRAL_BONUS",
        "remainingAmount": 50000,
        "usedAmount": 0,
        "expiresAt": "2026-08-10T...",
        "createdAt": "2026-02-10T..."
      },
      {
        "id": "clx...",
        "amount": 20000,
        "currency": "INR",
        "source": "REFEREE_BONUS",
        "remainingAmount": 20000,
        "usedAmount": 0,
        "expiresAt": "2026-08-10T...",
        "createdAt": "2026-02-10T..."
      }
    ]
  }
}
```

---

### GET /api/referrals/credits/available

Lightweight endpoint — returns only the available balance. Used by checkout pages.

**Auth**: Required

**Response** `200`:
```json
{
  "data": {
    "totalAvailable": 70000,
    "currency": "INR"
  }
}
```

---

## Integration Points

### Payment Webhook

**File**: `lib/payments/webhooks/handlers.ts`

After a successful payment, the webhook handler calls:

```typescript
processQualifyingAction(userId, "first_paid_booking")
```

This checks if the paying user was referred and, if so, triggers the reward flow.

### Referral Landing Page

**File**: `app/r/[code]/page.tsx`

Server-side rendered page that:
1. Validates the code via `validateReferralCode(code)`
2. Redirects to `/auth/signup?ref={code}` if valid
3. Redirects to `/auth/signup` if invalid

### Signup Page

**File**: `app/auth/signup/page.tsx`

Reads `?ref=CODE` from URL params:
- Calls `GET /api/referrals/code/check/{code}` to display referral banner
- After successful signup, calls `POST /api/referrals/apply` with the code
- Also shows an optional manual code input field
