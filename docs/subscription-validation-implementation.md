# Subscription Validation Implementation

## Overview

This implementation adds comprehensive subscription validation logic to prevent scheduling conflicts and enforce subscription-based weekly call limits. The solution addresses the requirement for different subscription types with specific rules:

- **Basic**: 1 call per week for 1 month (4-5 calls total)
- **Extended**: 2 calls per week for 6 months (48-52 calls total)
- **Comprehensive**: 3 calls per week for 6 months (72-78 calls total)

## Key Features

### 1. Week-Based Validation

- Prevents scheduling multiple calls in the same week if the subscription limit is reached
- Only allows one call to be removed/rescheduled if the week is fully booked
- Ensures all calls are within the subscription date range

### 2. Enhanced User Experience

- Real-time validation with immediate feedback
- Clear error messages explaining why scheduling failed
- Visual weekly overview showing availability
- Progress tracking for total subscription usage

### 3. Server-Side Validation Service

- `SubscriptionValidationService` class handles all validation logic
- Checks existing appointments against new slot proposals
- Validates subscription period boundaries
- Provides detailed weekly breakdown

## Implementation Files

### Core Service

- `utils/subscriptionValidation.ts` - Main validation service with all business logic

### API Updates

- `app/api/events/subscriptions/[subscriptionId]/validate/route.ts` - Enhanced validation endpoint
- `app/api/events/subscriptions/[subscriptionId]/allocate/route.ts` - Updated allocation with validation

### Frontend Components

- `useSubscriptionValidation.ts` - React hook for subscription validation
- `SubscriptionValidationDisplay.tsx` - UI component showing validation results
- `useSlotAllocation.ts` - Enhanced slot allocation hook

## Usage Example

```typescript
// Using the validation hook
const {
  validateSlots,
  getAvailableWeeks,
  canScheduleInWeek,
  lastValidationResult,
  getSubscriptionType,
} = useSubscriptionValidation({
  subscriptionId: "subscription-id",
  callsPerWeek: 1,
  durationInMonths: 1,
  sessionDurationInHours: 1,
});

// Validate proposed slots
const result = await validateSlots([
  "2025-07-02T10:00:00Z",
  "2025-07-09T10:00:00Z",
]);

// Check if result is valid
if (result.isValid) {
  // Proceed with scheduling
} else {
  // Show errors to user
  console.log(result.errors);
}
```

## Validation Rules

### Weekly Limits

1. Basic subscription: Maximum 1 call per week
2. Extended subscription: Maximum 2 calls per week
3. Comprehensive subscription: Maximum 3 calls per week

### Scheduling Constraints

1. Calls must be within subscription start and end dates
2. Cannot exceed total call allowance for subscription
3. If a week is fully booked, user must remove existing call before scheduling new one
4. Calls must be consecutive slots on the same day (for multi-slot sessions)

### Error Scenarios

- **Week Fully Booked**: "Week of [date] exceeds call limit. Maximum [X] calls per week allowed"
- **Outside Period**: "Slot [date] is outside subscription period ([start] - [end])"
- **Total Limit Exceeded**: "Total calls ([X]) exceed subscription limit ([Y])"

## UI Components

### SubscriptionValidationDisplay

Shows comprehensive validation status including:

- Overall subscription progress
- Weekly availability breakdown
- Error and warning messages
- Helpful scheduling guidelines

### Visual Indicators

- **Green**: Available weeks with open slots
- **Yellow**: Partially booked weeks
- **Red**: Fully booked weeks
- Progress bars showing subscription usage

## API Response Format

```json
{
  "data": {
    "conflicts": [],
    "outsideAvailability": [],
    "validSlots": ["2025-07-02T10:00:00Z"],
    "subscriptionValidation": {
      "isValid": true,
      "errors": [],
      "warnings": [],
      "weeklyInfo": [
        {
          "weekStart": "2025-06-29T00:00:00Z",
          "weekEnd": "2025-07-05T23:59:59Z",
          "existingCalls": 0,
          "maxCalls": 1,
          "canScheduleMore": true,
          "availableSlots": 1
        }
      ],
      "totalCallsScheduled": 1,
      "maxTotalCalls": 5,
      "subscriptionPeriod": {
        "start": "2025-07-02T00:00:00Z",
        "end": "2025-08-02T00:00:00Z"
      }
    }
  }
}
```

## Testing Scenarios

### Basic Subscription (1 call/week, 1 month)

1. ✅ Schedule 1 call in week 1
2. ❌ Try to schedule 2nd call in same week
3. ✅ Schedule call in week 2
4. ❌ Try to schedule 6th call (exceeds total limit)

### Extended Subscription (2 calls/week, 6 months)

1. ✅ Schedule 2 calls in week 1
2. ❌ Try to schedule 3rd call in same week
3. ✅ Remove 1 call, then schedule new call in same week
4. ✅ Schedule calls across multiple weeks

### Error Handling

1. ❌ Schedule call before subscription start date
2. ❌ Schedule call after subscription end date
3. ❌ Schedule overlapping slots
4. ❌ Schedule non-consecutive slots for multi-hour sessions

## Integration Points

### Existing Systems

- Integrates with current appointment booking flow
- Maintains compatibility with existing validation
- Uses established Prisma database queries
- Follows existing API patterns

### Future Enhancements

- Add subscription pause/resume functionality
- Implement rollover of unused calls
- Add bulk scheduling capabilities
- Integrate with calendar sync features
