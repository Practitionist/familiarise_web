# Seeding Updates for Subscription Validation

## Overview

Updated the seeding files to create realistic data that aligns with the subscription validation implementation requirements. The changes ensure proper synchronization between consultees and consultants for testing the subscription validation system.

## Key Changes Made

### 1. Subscription Plans (`createSubscriptionPlans.ts`)

**Updated Plan Structure:**

- **Basic Subscription**: 1 call/week for 1 month (4-5 calls total)
- **Extended Subscription**: 2 calls/week for 6 months (48-52 calls total)
- **Comprehensive Subscription**: 3 calls/week for 6 months (72-78 calls total)

**Improvements:**

- Realistic descriptions aligned with plan types
- Proper pricing tiers ($99-$199, $399-$799, $599-$999)
- Consistent learning outcomes and prerequisites
- Better material descriptions

### 2. Appointment Creation (`createAppointments.ts`)

**Enhanced Subscription Appointments:**

- **Distribution**: Increased subscription appointments (200 out of 500 total)
- **Realistic Slot Calculation**: Based on actual plan specifications
- **Week-Based Scheduling**: Slots distributed across weeks according to plan limits
- **Business Hours**: All slots scheduled during 9 AM - 6 PM business hours
- **Weekday Distribution**: Calls spread across Monday-Friday

**Slot Distribution Logic:**

```typescript
// Basic: 4-5 slots (1 call/week for 1 month)
// Extended: 48-52 slots (2 calls/week for 6 months)
// Comprehensive: 72-78 slots (3 calls/week for 6 months)
```

### 3. Availability Slots (`createSlotsOfAvailability.ts`)

**Business Hours Focus:**

- **Weekly Slots**: 3-5 slots per weekday (Monday-Friday)
- **Business Hours**: 9 AM, 10 AM, 11 AM, 2 PM, 3 PM, 4 PM, 5 PM
- **Weekend Options**: 20% of consultants have weekend availability
- **Custom Slots**: 2-4 slots per week for 3 months
- **1-Hour Sessions**: All slots are 1-hour duration

**Improved Scheduling:**

- Realistic business hour distribution
- Proper weekday/weekend balance
- Consistent slot durations
- Better timezone handling

## Data Synchronization

### Consultant-Consultee Alignment

1. **Plan Matching**: Consultees are assigned to consultants with matching expertise
2. **Schedule Compatibility**: Appointments created only during consultant availability
3. **Realistic Workload**: Consultants have appropriate number of clients
4. **Status Distribution**: Mix of pending, approved, and completed appointments

### Validation Testing Scenarios

The seeded data now supports testing of all validation scenarios:

1. **Basic Subscription Testing**:
   - 1 call per week limit enforcement
   - 4-5 total calls maximum
   - Week boundary validation

2. **Extended Subscription Testing**:
   - 2 calls per week limit enforcement
   - 48-52 total calls maximum
   - Multi-week scheduling validation

3. **Comprehensive Subscription Testing**:
   - 3 calls per week limit enforcement
   - 72-78 total calls maximum
   - Long-term scheduling validation

## Seeding Statistics

### Generated Data:

- **Users**: 100 total (40 consultants, 60 consultees)
- **Subscription Plans**: 120 plans (3 per consultant)
- **Appointments**: 500 total (200 subscriptions for testing)
- **Availability Slots**: 3-5 per weekday per consultant
- **Business Hours**: 9 AM - 6 PM focus

### Distribution:

- **Basic Subscriptions**: ~33% of subscription appointments
- **Extended Subscriptions**: ~33% of subscription appointments
- **Comprehensive Subscriptions**: ~34% of subscription appointments

## Usage Instructions

### Re-seed Database:

```bash
npm run scripts:seed
```

### Test Validation Scenarios:

1. Try to schedule more than allowed calls per week
2. Attempt to exceed total call limits
3. Test week boundary validations
4. Verify business hour constraints

## Benefits

1. **Realistic Testing**: Data matches real-world subscription scenarios
2. **Validation Coverage**: All validation rules can be tested
3. **Performance Testing**: Large dataset for stress testing
4. **Edge Case Testing**: Various appointment statuses and timeframes
5. **Business Logic Validation**: Proper consultant-consultee relationships

The updated seeding ensures that the subscription validation system can be thoroughly tested with realistic, well-structured data that mirrors actual business scenarios.
