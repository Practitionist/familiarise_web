# Subscription weekly calls logic

A basic subscription includes 1 call per week. Weeks are defined as Sunday to Saturday. The number of calls for a subscription is the number of distinct Sunday–Saturday weeks that intersect the subscription period.

Definition:

- First week: Sunday–Saturday week that contains the subscription start date.
- Last week: Sunday–Saturday week that contains the subscription end date.

The result is typically 4 or 5 weeks for a monthly subscription.

## Example

Start: 2021-08-02 (Monday)
End: 2021-09-02 (Thursday)

Weeks counted:

- 2021-08-01 (Sun) – 2021-08-07 (Sat)
- 2021-08-08 (Sun) – 2021-08-14 (Sat)
- 2021-08-15 (Sun) – 2021-08-21 (Sat)
- 2021-08-22 (Sun) – 2021-08-28 (Sat)
- 2021-08-29 (Sun) – 2021-09-04 (Sat) ← contains end date, so included

Total calls = 5

## Usage

```ts
import { getWeeklyCallCount, getWeekBoundaries } from "@/utils/subscription";

const start = new Date("2021-08-02");
const end = new Date("2021-09-02");

const calls = getWeeklyCallCount(start, end); // 5
const weeks = getWeekBoundaries(start, end);
// weeks is an array of { weekStart, weekEnd } for each week included
```

## Notes

- If start or end falls exactly on a Sunday or Saturday, that week is counted.
- The function normalizes dates to midnight (local time) to avoid DST/timezone artifacts when comparing.
- If endDate < startDate, the result is 0 weeks.
