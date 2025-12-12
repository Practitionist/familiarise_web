# API Reference

## Authentication

All endpoints require authentication with admin or staff role:

```typescript
// Required headers
Authorization: Bearer<session_token>;

// Session validation
const session = await getServerSession(authOptions);
if (!session?.user) {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// Role check
const user = await prisma.user.findUnique({ where: { id: session.user.id } });
if (user?.role !== "ADMIN" && user?.role !== "STAFF") {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
```

---

## Refunds API

### POST /api/payments/refunds

Create a refund for a payment.

**Request Body:**

```typescript
{
  paymentId: string;    // Required: Payment ID to refund
  amount?: number;      // Optional: Partial refund amount (in cents/paise)
  reason?: string;      // Optional: Reason for refund
}
```

**Validation Schema:**

```typescript
const createRefundSchema = z.object({
  paymentId: z.string().min(1, "Payment ID is required"),
  amount: z.number().positive().optional(),
  reason: z.string().optional(),
});
```

**Success Response (200):**

```json
{
  "success": true,
  "refund": {
    "id": "clx123abc",
    "refundId": "re_1234567890",
    "amount": 10000,
    "currency": "USD",
    "status": "SUCCEEDED",
    "paymentId": "clx456def"
  },
  "message": "Refund created successfully"
}
```

**Error Responses:**

| Status | Error                                      | Cause                           |
| ------ | ------------------------------------------ | ------------------------------- |
| 400    | "Only successful payments can be refunded" | Payment status is not SUCCEEDED |
| 400    | "Payment has already been fully refunded"  | No remaining balance            |
| 400    | "Refund amount exceeds available balance"  | Requested amount too high       |
| 401    | "Unauthorized"                             | No valid session                |
| 403    | "Forbidden - Admin access required"        | User is not admin/staff         |
| 404    | "Payment not found"                        | Invalid payment ID              |
| 500    | Gateway error message                      | Payment gateway failure         |

**Example:**

```bash
# Full refund
curl -X POST /api/payments/refunds \
  -H "Content-Type: application/json" \
  -d '{"paymentId": "clx123abc"}'

# Partial refund ($50.00)
curl -X POST /api/payments/refunds \
  -H "Content-Type: application/json" \
  -d '{"paymentId": "clx123abc", "amount": 5000, "reason": "Partial service"}'
```

---

### GET /api/payments/refunds

List refunds, optionally filtered by payment.

**Query Parameters:**

| Parameter   | Type   | Default | Description          |
| ----------- | ------ | ------- | -------------------- |
| `paymentId` | string | -       | Filter by payment ID |
| `limit`     | number | 10      | Max results (1-100)  |

**Success Response (200):**

```json
{
  "refunds": [
    {
      "id": "clx123abc",
      "refundId": "re_1234567890",
      "amount": 10000,
      "currency": "USD",
      "status": "SUCCEEDED",
      "reason": "Customer request",
      "gateway": "STRIPE",
      "createdAt": "2025-12-11T10:00:00Z",
      "payment": {
        "id": "clx456def",
        "amount": 10000,
        "user": {
          "id": "user123",
          "email": "user@example.com",
          "name": "John Doe"
        },
        "appointment": {
          "id": "apt789",
          "appointmentType": "CONSULTATION"
        }
      }
    }
  ],
  "count": 1
}
```

**With paymentId (from gateway):**

```json
{
  "refunds": [
    {
      "id": "re_1234567890",
      "amount": 10000,
      "currency": "usd",
      "status": "succeeded",
      "reason": "requested_by_customer"
    }
  ],
  "paymentId": "clx456def",
  "count": 1
}
```

---

## Disputes API

### GET /api/payments/disputes

List all disputes from the database.

**Query Parameters:**

| Parameter | Type   | Default | Description                             |
| --------- | ------ | ------- | --------------------------------------- |
| `gateway` | string | -       | Filter by gateway (STRIPE only for API) |
| `limit`   | number | 10      | Max results                             |

**Success Response (200):**

```json
{
  "disputes": [
    {
      "id": "clx123abc",
      "disputeId": "dp_1234567890",
      "amount": 10000,
      "currency": "USD",
      "status": "NEEDS_RESPONSE",
      "reason": "fraudulent",
      "gateway": "STRIPE",
      "dueBy": "2025-12-20T00:00:00Z",
      "isChargeRefundable": true,
      "createdAt": "2025-12-11T10:00:00Z",
      "payment": {
        "id": "clx456def",
        "amount": 10000,
        "user": {
          "id": "user123",
          "email": "user@example.com",
          "name": "John Doe"
        },
        "appointment": {
          "id": "apt789",
          "appointmentType": "CONSULTATION"
        }
      }
    }
  ],
  "count": 1
}
```

---

### POST /api/payments/disputes

Submit evidence for a dispute.

**Request Body:**

```typescript
{
  disputeId: string;    // Required: Database dispute ID
  evidence: {
    customerName?: string;
    customerEmailAddress?: string;
    customerPurchaseIp?: string;
    cancellationPolicy?: string;
    cancellationPolicyDisclosure?: string;
    cancellationRebuttal?: string;
    duplicateChargeId?: string;
    duplicateChargeExplanation?: string;
    duplicateChargeDocumentation?: string;
    productDescription?: string;
    receipt?: string;
    customerCommunication?: string;
    uncategorizedText?: string;
    uncategorizedFile?: string;
  };
}
```

**Validation Schema:**

```typescript
const submitEvidenceSchema = z.object({
  disputeId: z.string().min(1, "Dispute ID is required"),
  evidence: z.object({
    customerName: z.string().optional(),
    customerEmailAddress: z.string().email().optional(),
    customerPurchaseIp: z.string().optional(),
    cancellationPolicy: z.string().optional(),
    cancellationPolicyDisclosure: z.string().optional(),
    cancellationRebuttal: z.string().optional(),
    duplicateChargeId: z.string().optional(),
    duplicateChargeExplanation: z.string().optional(),
    duplicateChargeDocumentation: z.string().optional(),
    productDescription: z.string().optional(),
    receipt: z.string().optional(),
    customerCommunication: z.string().optional(),
    uncategorizedText: z.string().optional(),
    uncategorizedFile: z.string().optional(),
  }),
});
```

**Success Response (200):**

```json
{
  "success": true,
  "dispute": {
    "id": "clx123abc",
    "disputeId": "dp_1234567890",
    "status": "UNDER_REVIEW",
    "isChargeRefundable": true,
    "dueBy": "2025-12-20T00:00:00Z"
  },
  "message": "Evidence submitted successfully"
}
```

**Error Responses:**

| Status | Error                                                | Cause                              |
| ------ | ---------------------------------------------------- | ---------------------------------- |
| 400    | "Dispute is already resolved..."                     | Status is WON/LOST/CHARGE_REFUNDED |
| 400    | "Only Stripe supports direct evidence submission..." | Gateway is RAZORPAY                |
| 401    | "Unauthorized"                                       | No valid session                   |
| 403    | "Forbidden - Admin access required"                  | User is not admin/staff            |
| 404    | "Dispute not found"                                  | Invalid dispute ID                 |
| 500    | Gateway error message                                | Stripe API failure                 |

---

## Admin Disputes API

### GET /api/admin/disputes

List disputes with pagination and filtering (admin dashboard).

**Query Parameters:**

| Parameter | Type           | Default | Description          |
| --------- | -------------- | ------- | -------------------- |
| `page`    | number         | 1       | Page number          |
| `limit`   | number         | 20      | Results per page     |
| `status`  | DisputeStatus  | -       | Filter by status     |
| `gateway` | PaymentGateway | -       | Filter by gateway    |
| `search`  | string         | -       | Search by dispute ID |

**Success Response (200):**

```json
{
  "disputes": [...],
  "total": 50,
  "urgentDisputes": 3,
  "page": 1,
  "limit": 20,
  "totalPages": 3
}
```

---

### GET /api/admin/disputes/[disputeId]

Get detailed information about a specific dispute.

**Path Parameters:**

| Parameter   | Type   | Description         |
| ----------- | ------ | ------------------- |
| `disputeId` | string | Database dispute ID |

**Success Response (200):**

```json
{
  "id": "clx123abc",
  "disputeId": "dp_1234567890",
  "amount": 10000,
  "currency": "USD",
  "reason": "fraudulent",
  "status": "NEEDS_RESPONSE",
  "dueBy": "2025-12-20T00:00:00Z",
  "isChargeRefundable": true,
  "evidence": null,
  "paymentGateway": "STRIPE",
  "createdAt": "2025-12-11T10:00:00Z",
  "updatedAt": "2025-12-11T10:00:00Z",
  "payment": {
    "id": "clx456def",
    "paymentIntent": "pi_1234567890",
    "user": {
      "id": "user123",
      "name": "John Doe",
      "email": "user@example.com"
    }
  }
}
```

**Error Responses:**

| Status | Error               | Cause              |
| ------ | ------------------- | ------------------ |
| 401    | "Unauthorized"      | No valid session   |
| 403    | "Forbidden"         | User is not admin  |
| 404    | "Dispute not found" | Invalid dispute ID |

---

## Error Response Format

All error responses follow this format:

```json
{
  "error": "Error message",
  "details": [...]  // Optional: Zod validation errors
}
```

**Zod Validation Error Example:**

```json
{
  "error": "Validation error",
  "details": [
    {
      "code": "too_small",
      "minimum": 1,
      "type": "string",
      "inclusive": true,
      "exact": false,
      "message": "Payment ID is required",
      "path": ["paymentId"]
    }
  ]
}
```
