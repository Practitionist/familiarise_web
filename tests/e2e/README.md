# E2E Tests for Booking Algorithm

This directory contains Playwright end-to-end tests for the consultation booking system, based on the test specifications in `prompts/1.txt` and `prompts/2.txt`.

## Test Suites

### 1. Display Verification Tests (`booking/display-verification.spec.ts`)

- **Test 1.1**: Availability Slot Display - Verifies consultant availability shows correctly
- **Test 1.2**: Booked Slot Display - Verifies booked appointments display correctly
- **Test 1.3**: Calendar View Switching - Tests switching between week/month views
- **Test 1.4**: Slot Status Colors - Verifies different slot statuses have different appearances
- **Test 1.5**: Timezone Display - Verifies timezone conversion from UTC to local

### 2. Auto-Allocation Consultation Tests (`booking/auto-allocation-consultation.spec.ts`)

- **Test 2.1**: Basic Auto-Allocation - Verifies consecutive slot allocation
- **Test 2.2**: Different Durations - Tests allocation for various consultation durations
- **Test 2.3**: No Double Booking - Verifies conflict prevention

**Business Rules Tested:**

- ✅ All slots on same day
- ✅ Consecutive 30-minute slots
- ✅ Single appointment with multiple slots
- ✅ Status changes PENDING → SCHEDULED

### 3. Auto-Allocation Subscription Tests (`booking/auto-allocation-subscription.spec.ts`)

- **Test 2.4**: Weekly Limit Enforcement - Verifies max callsPerWeek per week
- **Test 2.5**: Total Call Count - Verifies correct total appointments
- **Test 2.6**: Session Duration - Verifies each session has correct duration

**Business Rules Tested:**

- ✅ Max 1 call per day
- ✅ Max callsPerWeek calls per week
- ✅ Distributed across durationInMonths
- ✅ Multiple appointments created

### 4. Manual Allocation Validation Tests (`booking/manual-allocation.spec.ts`)

- **Test 4.1**: Same-Day Rule - Verifies all slots must be on same day
- **Test 4.2**: Consecutive Slots Rule - Verifies slots must be consecutive
- **Test 4.3**: Conflict Detection - Verifies booked slots are not selectable

**Business Rules Tested:**

- ✅ Same-day validation
- ✅ Consecutive validation
- ✅ Conflict prevention

## Setup

### Prerequisites

1. Database with test data (consultants, consultees, availability slots)
2. Environment variables configured
3. Development server running

### Environment Variables

Create a `.env.test.local` file:

```bash
# Database
DATABASE_URL="your_supabase_connection_string"
DIRECT_URL="your_direct_connection_string"

# Test Users
TEST_CONSULTANT_EMAIL="consultant@test.com"
TEST_CONSULTANT_PASSWORD="Test@123"
TEST_CONSULTEE_EMAIL="consultee@test.com"
TEST_CONSULTEE_PASSWORD="Test@123"

# Test Configuration
PLAYWRIGHT_BASE_URL="http://localhost:3000"
```

### Installation

```bash
# Install Playwright browsers
npx playwright install

# Install dependencies (if not already done)
npm install
```

## Running Tests

### Run all tests

```bash
npx playwright test
```

### Run specific test suite

```bash
npx playwright test tests/e2e/booking/display-verification.spec.ts
npx playwright test tests/e2e/booking/auto-allocation-consultation.spec.ts
npx playwright test tests/e2e/booking/auto-allocation-subscription.spec.ts
npx playwright test tests/e2e/booking/manual-allocation.spec.ts
```

### Run tests in headed mode (see browser)

```bash
npx playwright test --headed
```

### Run tests in debug mode

```bash
npx playwright test --debug
```

### Run specific test

```bash
npx playwright test -g "Test 1.1"
```

## Viewing Results

### HTML Report

After tests complete, view the HTML report:

```bash
npx playwright show-report
```

### Screenshots

Failed test screenshots are saved to `test-screenshots/`

### Videos

Failed test videos are saved to `test-results/`

## Test Data Requirements

For tests to run successfully, your database needs:

1. **At least one consultant** with:
   - Weekly or custom availability slots
   - One or more consultation plans
   - One or more subscription plans

2. **At least one consultee** profile

3. **Pending requests**:
   - At least one pending consultation request
   - Optionally, pending subscription requests

### Creating Test Data

You can use the Prisma seed script or create test data manually:

```bash
npm run scripts:seed
```

Or insert test data via SQL:

```sql
-- Create test consultant
INSERT INTO "ConsultantProfile" (id, "userId", "scheduleType", "domainId")
VALUES ('test-consultant-1', 'user-id', 'WEEKLY', 'domain-id');

-- Create availability slots
INSERT INTO "SlotOfAvailabilityWeekly" (
  id,
  "consultantProfileId",
  "dayOfWeekforStartTimeInUTC",
  "slotStartTimeInUTC",
  "slotEndTimeInUTC"
)
VALUES (
  gen_random_uuid(),
  'test-consultant-1',
  'MONDAY',
  '2025-01-06 10:00:00+00',
  '2025-01-06 12:00:00+00'
);
```

## Troubleshooting

### Tests skip due to no data

- Ensure you have test data in the database
- Check that TEST_CONSULTANT_EMAIL user exists and has availability
- Verify pending requests exist

### Authentication fails

- Check TEST_CONSULTANT_EMAIL and TEST_CONSULTANT_PASSWORD are correct
- Ensure user exists in database
- Verify /auth/signin route is accessible

### Selectors not found

- Check that the UI components match the selectors in `helpers/selectors.ts`
- Update selectors if UI structure has changed
- Use `--debug` mode to inspect elements

### Database connection issues

- Verify DATABASE_URL is correct
- Check Prisma schema is generated: `npx prisma generate`
- Test database connection: `npx prisma db pull`

## Test Structure

```
tests/e2e/
├── booking/                 # Test files
│   ├── display-verification.spec.ts
│   ├── auto-allocation-consultation.spec.ts
│   ├── auto-allocation-subscription.spec.ts
│   └── manual-allocation.spec.ts
├── helpers/                 # Helper utilities
│   ├── database.ts          # Database queries
│   ├── auth.ts              # Authentication helpers
│   └── selectors.ts         # Page objects
├── fixtures/                # Test fixtures
│   └── test-data.ts         # Test fixtures and setup
└── README.md                # This file
```

## Contributing

When adding new tests:

1. Follow the existing pattern in test files
2. Use page objects from `helpers/selectors.ts`
3. Add database helpers to `helpers/database.ts` if needed
4. Document business rules being tested
5. Include descriptive test names
6. Add screenshots for visual verification

## Reference

Test specifications are based on:

- `prompts/1.txt` - Comprehensive testing guide
- `prompts/2.txt` - Practical testing commands

Business rules are defined in the Prisma schema:

- `prisma/schema.prisma`
