# Multiple Failed Attempts → Success Flow

## Scenario: User Attempts Booking Multiple Times

This document explains how the system handles the scenario where a user fails on the first and second attempts (due to exit, network disconnect, etc.) but succeeds on the third attempt.

## **Enhanced Flow Implementation** ✅

### **What Happens Now**

```mermaid
graph TD
    A[Attempt 1: User starts checkout] --> B{Slot Availability Check}
    B -->|No conflicts| C[Create tentative appointment 1]
    C --> D[User exits/crashes]
    
    E[Attempt 2: User tries again] --> F{Enhanced Validation}
    F -->|User has recent pending?| G[Block: "Complete current payment"]
    F -->|Timeout passed?| H[Allow new attempt]
    H --> I[Create tentative appointment 2] 
    I --> J[User exits/crashes again]
    
    K[Attempt 3: After timeout] --> L{Enhanced Validation}
    L -->|Clear to proceed| M[Create tentative appointment 3]
    M --> N[User completes payment ✅]
    N --> O[Appointment 3 confirmed]
    
    P[Cleanup Job Runs] --> Q[Remove appointments 1 & 2]
```

### **Key Improvements**

## 1. **User-Based Deduplication** 🚫

**Problem Solved**: Prevents same user from creating multiple pending bookings for the same slot.

```typescript
// Enhanced validation checks for recent attempts by same user
const recentAttempt = await tx.slotOfAppointment.findFirst({
  where: {
    // Same slot overlap logic
    isTentative: true,
    appointment: {
      payment: {
        some: {
          userId: userId,
          paymentStatus: "PENDING",
          createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } // 5 min window
        }
      }
    }
  }
});
```

**User Experience**:
- **Attempt 1**: ✅ Creates tentative booking
- **Attempt 2** (within 5 min): ❌ "You already have a pending booking for this time slot. Please complete your current payment or wait a few minutes to try again."
- **Attempt 3** (after 5 min): ✅ Allowed to try again

## 2. **Rate Limiting Protection** 🛡️

**Problem Solved**: Prevents slot spam and ensures availability for other users.

```typescript
// Check for excessive tentative bookings 
const tentativeCount = await tx.slotOfAppointment.count({
  where: {
    // Same slot overlap logic
    isTentative: true,
    appointment: {
      payment: {
        some: {
          paymentStatus: "PENDING",
          createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) } // 30 min window
        }
      }
    }
  }
});

if (tentativeCount >= 3) {
  throw new Error("This time slot is temporarily unavailable due to high demand. Please try again later.");
}
```

**System Protection**:
- Max **3 pending attempts** per slot within 30 minutes
- Prevents slot hoarding and system abuse
- Ensures fair access for all users

## 3. **Automatic Cleanup** 🧹

**Background Process**: The cleanup job handles orphaned bookings.

```typescript
// Cleanup runs every 15 minutes
const abandonedThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago

const abandonedAppointments = await prisma.appointment.findMany({
  where: {
    createdAt: { lt: abandonedThreshold },
    slotsOfAppointment: { some: { isTentative: true } },
    payment: { some: { paymentStatus: "PENDING" } }
  }
});

// For each abandoned appointment:
// 1. Cancel payment intent at gateway
// 2. Mark payment as FAILED
// 3. Remove tentative appointments
```

## **Timeline Example** ⏱️

### **Real-World Scenario**

```
10:00 AM - User starts booking 2:00 PM slot
10:01 AM - Payment gateway loads, user's phone dies
10:05 AM - User tries again → BLOCKED ("complete current payment")
10:07 AM - User tries again → BLOCKED (still within 5-min window)  
10:12 AM - User tries again → ✅ ALLOWED (5-min timeout passed)
10:13 AM - Payment succeeds → Appointment confirmed
10:30 AM - Cleanup job runs → Removes first two abandoned attempts
```

## **Error Messages** 💬

### **User-Friendly Feedback**

1. **Duplicate Attempt (within 5 min)**:
   ```
   "You already have a pending booking for this time slot. 
   Please complete your current payment or wait a few minutes to try again."
   ```

2. **Slot Under High Demand**:
   ```
   "This time slot is temporarily unavailable due to high demand. 
   Please try again later."
   ```

3. **Already Confirmed**:
   ```
   "Time slot is already booked."
   ```

## **Benefits** 🎯

### **For Users**
- **Clear feedback** on why booking failed
- **Prevents confusion** from multiple pending payments
- **Fair access** to popular time slots
- **Graceful retry** mechanism after reasonable timeout

### **For System**
- **Prevents resource leakage** from abandoned bookings
- **Reduces database bloat** with automatic cleanup
- **Protects against abuse** with rate limiting
- **Maintains data consistency** across payment flows

### **For Business**
- **Reduces support tickets** from confused users
- **Prevents overbooking** scenarios
- **Improves conversion rates** with better UX
- **Ensures payment gateway efficiency**

## **Monitoring & Analytics** 📊

### **Key Metrics to Track**

1. **Abandonment Rate**: % of tentative bookings that get cleaned up
2. **Retry Attempts**: How often users hit the 5-minute block
3. **Slot Contention**: How often the 3-attempt limit is triggered
4. **Cleanup Efficiency**: Number of orphaned appointments removed per run

### **Alerting Triggers**

- **High abandonment rate** (>30%) → Payment gateway issues?
- **Frequent retry blocks** → UX improvement needed?
- **Many slot contentions** → Popular slot capacity planning?
- **Cleanup failures** → Database or payment gateway connectivity issues?

## **Configuration** ⚙️

### **Adjustable Parameters**

```typescript
// Time windows (easily configurable)
const USER_RETRY_TIMEOUT = 5 * 60 * 1000;      // 5 minutes
const SLOT_RATE_LIMIT_WINDOW = 30 * 60 * 1000; // 30 minutes  
const CLEANUP_ABANDONMENT_AGE = 30 * 60 * 1000; // 30 minutes
const MAX_PENDING_ATTEMPTS_PER_SLOT = 3;       // 3 attempts

// These can be moved to environment variables for easy tuning
```

### **Environment Variables**

```bash
# Booking behavior controls
USER_RETRY_TIMEOUT_MINUTES=5
SLOT_RATE_LIMIT_WINDOW_MINUTES=30
CLEANUP_ABANDONMENT_AGE_MINUTES=30
MAX_PENDING_ATTEMPTS_PER_SLOT=3

# Cleanup job frequency
CLEANUP_JOB_INTERVAL_MINUTES=15
```

## **Testing Scenarios** 🧪

### **Test Cases to Validate**

1. **Normal Flow**: Single attempt → success
2. **Quick Retry**: Attempt → fail → immediate retry (should block)
3. **Delayed Retry**: Attempt → fail → wait 6 min → retry (should allow)
4. **Slot Contention**: 4 users try same slot quickly (4th should block)
5. **Cleanup Verification**: Create abandoned booking → wait 35 min → verify cleanup
6. **Payment Gateway Recovery**: Failed payment intent cancellation doesn't stop cleanup

### **Load Testing**

- **Concurrent bookings** for same slot
- **High abandonment rates** (many users exiting)
- **Cleanup job performance** under high load
- **Database transaction conflicts** under pressure

This enhanced system provides **robust protection** against the multiple failed attempts scenario while maintaining **excellent user experience** and **system reliability**. 