# Schema Design Correction: Removing Duplication

## Issue Identified ❌

**Question**: "Why do we have `paymentExpiresAt` besides `payment.expiresAt`? Is this duplication?"

**Answer**: Yes, this was **poor database design** with redundant fields.

## **The Problem**

### **Before (Redundant Design)**

```typescript
model Appointment {
  id               String   @id @default(uuid())
  paymentExpiresAt DateTime? // ❌ REDUNDANT
  payment          Payment[]
  // ...
}

model Payment {
  id        String   @id @default(uuid())
  expiresAt DateTime? // ✅ CORRECT LOCATION
  // ...
}
```

### **Issues with Duplication**

1. **Violates Single Source of Truth**: Same data stored in two places
2. **Data Inconsistency Risk**: Fields might have different values
3. **Maintenance Burden**: Need to update both fields
4. **Database Bloat**: Unnecessary storage
5. **Query Complexity**: Confusion about which field to use

## **Corrected Design** ✅

### **After (Clean Design)**

```typescript
model Appointment {
  id      String   @id @default(uuid())
  payment Payment[]
  // ✅ No redundant paymentExpiresAt
}

model Payment {
  id        String   @id @default(uuid())
  expiresAt DateTime? // ✅ Single source of truth
  // ...
}
```

### **Why This is Better**

1. **Single Source of Truth**: Expiration tracked only in `Payment` model
2. **Logical Placement**: Payment expiration belongs with payment data
3. **Data Integrity**: No risk of field inconsistency
4. **Simpler Queries**: Clear which field to use
5. **Better Performance**: Less storage and index overhead

## **Updated Implementation** 🔧

### **1. Schema Changes**

```diff
model Appointment {
  id                 String              @id @default(uuid())
  appointmentType    AppointmentsType
  slotsOfAppointment SlotOfAppointment[]
- paymentExpiresAt   DateTime?          // ❌ Removed redundant field

  payment Payment[]
  // ...
- @@index([paymentExpiresAt])           // ❌ Removed redundant index
}

model Payment {
  id        String   @id @default(uuid())
  expiresAt DateTime? // ✅ Only field for payment expiration
  // ...
+ @@index([expiresAt, paymentStatus])   // ✅ Proper indexing
}
```

### **2. Checkout Logic**

```typescript
// ✅ Set expiration in the right place
await prisma.payment.create({
  data: {
    // ... other payment fields
    expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes from now
  },
});
```

### **3. Cleanup Query**

```typescript
// ✅ Use payment expiration for abandoned payment detection
const abandonedAppointments = await prisma.appointment.findMany({
  where: {
    payment: {
      some: {
        AND: [
          { paymentStatus: "PENDING" },
          {
            OR: [
              { expiresAt: { lt: new Date() } }, // Explicitly expired
              {
                AND: [
                  { expiresAt: null }, // No expiration set (legacy)
                  { createdAt: { lt: abandonedThreshold } }, // Fallback to creation time
                ],
              },
            ],
          },
        ],
      },
    },
  },
});
```

### **4. Validation Logic**

```typescript
// ✅ User deduplication using payment expiration
const recentAttempt = await tx.slotOfAppointment.findFirst({
  where: {
    // ... slot overlap logic
    appointment: {
      payment: {
        some: {
          AND: [
            { userId: userId },
            { paymentStatus: "PENDING" },
            {
              OR: [
                { expiresAt: { gt: new Date() } }, // Not yet expired
                {
                  AND: [
                    { expiresAt: null }, // No expiration set (legacy)
                    {
                      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  },
});
```

## **Database Design Principles Applied** 📚

### **1. Normalization**

- **Rule**: Don't store the same data in multiple places
- **Applied**: Expiration data only in `Payment` model

### **2. Single Source of Truth**

- **Rule**: Each piece of data should have one authoritative location
- **Applied**: `Payment.expiresAt` is the only expiration field

### **3. Logical Data Placement**

- **Rule**: Store data where it logically belongs
- **Applied**: Payment expiration belongs with payment records

### **4. Referential Integrity**

- **Rule**: Use relationships instead of duplication
- **Applied**: Query payment expiration through appointment → payment relationship

## **Migration Strategy** 🔄

### **For Existing Systems**

1. **Data Migration** (if needed):

   ```sql
   -- If paymentExpiresAt had data, migrate to Payment.expiresAt
   UPDATE "Payment"
   SET "expiresAt" = (
     SELECT "paymentExpiresAt"
     FROM "Appointment"
     WHERE "Appointment"."id" = "Payment"."appointmentId"
   )
   WHERE "expiresAt" IS NULL
     AND EXISTS (
       SELECT 1 FROM "Appointment"
       WHERE "Appointment"."id" = "Payment"."appointmentId"
         AND "paymentExpiresAt" IS NOT NULL
     );
   ```

2. **Schema Update**:

   ```sql
   -- Remove redundant field and index
   DROP INDEX IF EXISTS "Appointment_paymentExpiresAt_idx";
   ALTER TABLE "Appointment" DROP COLUMN "paymentExpiresAt";
   ```

3. **Application Update**: Update all queries to use `Payment.expiresAt`

### **For New Systems**

- ✅ Start with clean schema (no redundant fields)
- ✅ Implement proper indexing on `Payment.expiresAt`

## **Performance Benefits** ⚡

### **Storage Savings**

- **Removed Field**: 8 bytes per appointment record
- **Removed Index**: Reduced index storage and maintenance

### **Query Simplification**

- **Before**: Confusion about which expiration field to use
- **After**: Clear, single field for all payment expiration queries

### **Maintenance Reduction**

- **Before**: Risk of fields getting out of sync
- **After**: Single field to manage

## **Key Takeaways** 💡

1. **Always question redundancy** during schema design
2. **Follow normalization principles** to avoid duplication
3. **Place data where it logically belongs** (payment data in payment model)
4. **Use relationships** instead of duplicating data
5. **Regular schema reviews** help catch design issues early

This correction demonstrates the importance of **careful schema design** and the benefits of **eliminating redundancy** for better **data integrity**, **performance**, and **maintainability**.
