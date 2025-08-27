GPT 5 PR review:

I scanned the PR branch and focused on Stream Chat/Video areas. Here are concrete issues to fix:

### Bugs
- components/chat/ChatSidebar.tsx
  - In event handlers updating channel lists you compare `ch.cid === event.channel?.id`. This mismatches id vs cid and prevents updates. Use `event.channel?.cid` or compare `ch.id === event.channel?.id`.
- components/chat/CreateDirectMessageDialog.tsx
  - 1:1 DM `channelId = dm-<first8>-<first8>` risks collisions and can join the wrong conversation if ids share prefixes. Prefer no explicit id: `client.channel('messaging', { members })` + `watch()`, or build a stable hash from full sorted member ids.

### Security gaps
- app/api/stream/channels/create/route.ts
  - No auth/authorization check; trusts `createdById` from the body. Enforce session with `getServerSession`, ensure requester matches `createdById`, and gate by role/permissions.
- lib/user.ts
  - `mapRoleToStream` returns `"admin"` for all roles. This is over-permissive; define minimal roles and update Stream Chat role permissions accordingly.

### Dead/unused code
- components/chat/InitializeChannelsButton.tsx
  - Unreferenced; remove or wire into UI.
- app/api/stream/sync/background/route.ts
  - `serverStreamClient` is created but never used; remove.

### Risky/fragile logic
- actions/stream/chat/event-channel.action.ts
  - `checkEventChannelExists` uses `channel.query()` with `created_by_id: 'system'` which may implicitly create channels depending on permissions and whether `system` exists. Safer: use `client.queryChannels({ id: channelId, type: 'team' }, {}, { limit: 1 })` to avoid accidental creation.

### Performance/optimization
- components/chat/ChatSidebar.tsx
  - Global `client.on("*.**", ...)` is heavy; restrict to needed events (`message.new`, `notification.added_to_channel`, `notification.removed_from_channel`, `channel.deleted`, `message.read`, `channel.updated`).
- Repository-wide
  - Excessive `console.log` in providers, API routes, and components. Wrap logs behind `if (process.env.NODE_ENV !== 'production')` or switch to a leveled logger.

### Minor robustness
- app/meetings/[id]/hooks/useGetCallById.ts
  - `queryCalls({ filter_conditions: { id: callId } })` is fine; consider adding `type: 'default'` to narrow results.
- components/chat/CreateDirectMessageDialog.tsx
  - For group DMs you generate `group-${hash}-${timestamp}`; if you want a single distinct group per member set, drop the timestamp and rely on a stable hash, or use server-side creation policy.

- I identified one real bug (cid/id mismatch), an auth gap in the new channels API, dead code, and a few collision/fragility/perf items.

Gemini code assist PR review:

gemini-code-assist bot reviewed 3 minutes ago
Contributor
gemini-code-assist bot left a comment
Code Review
This pull request introduces a significant and impressive overhaul of the event allocation and validation system. The changes are extensive, touching everything from backend API logic and database schemas to frontend components and utility functions. The introduction of a dedicated SubscriptionValidationService, more accurate date calculations, and event-specific constraints makes the system far more robust, maintainable, and correct. The UI enhancements, especially in the UnifiedCalendar, provide a much-improved user experience with real-time feedback. Overall, this is an excellent set of changes that greatly enhances the platform's scheduling capabilities. I've identified a couple of areas for improvement, detailed in the comments.

app/api/events/subscriptions/[subscriptionId]/allocate/route.ts
Comment on lines 160 to 163
  while (
    selectedSlots.length < totalRequiredSlots &&
    selectedSlots.length < totalRequiredCalls &&
    currentWeek < totalWeeks
  ) {
Contributor
@gemini-code-assist gemini-code-assist bot 3 minutes ago
high

The logic for auto-allocating subscription slots appears to only select one 30-minute slot per call, regardless of the sessionDurationInHours defined in the subscription plan. The loop condition selectedSlots.length < totalRequiredCalls and the logic inside the loop suggest that it finds a single available slot for each required call.

This is inconsistent with the allocateSlotsManual function in this file and the allocation logic for other event types like classes, which correctly find a block of consecutive slots to form a full session. If a subscription's sessionDurationInHours is greater than 0.5, this will result in booking appointments with incorrect, shorter durations.

To fix this, the logic should be updated to calculate the number of 30-minute slots required per session and then find that many consecutive available slots for each call, similar to how it's handled for classes.

Reply...
app/api/events/webinars/[webinarId]/validate/route.ts
Comment on lines 73 to 79
    if (body.slots.length !== requiredSlots) {
      const durationText = `${webinarDuration} hour${webinarDuration > 1 ? "s" : ""}`;
      return NextResponse.json(
        {
          error: `Webinar (${durationText}) requires exactly ${requiredSlots} consecutive slot${requiredSlots > 1 ? "s" : ""}`,
          error: `This webinar requires only ${requiredSlots} slots`,
        },
        { status: 400 },
      );
Contributor
@gemini-code-assist gemini-code-assist bot 3 minutes ago
medium

The updated error message is less informative than the original one. The previous version mentioned that the webinar requires a specific number of consecutive slots and included the duration, which gave the user more context about why their selection was invalid. The new message just states the required number of slots.

Consider restoring the more descriptive error message to improve user experience.

      const durationText = `${webinarDuration} hour${webinarDuration > 1 ? "s" : ""}`;
      return NextResponse.json(
        {
          error: `Webinar (${durationText}) requires exactly ${requiredSlots} consecutive slot${requiredSlots > 1 ? "s" : ""}`,
        },
        { status: 400 },
      );
Reply...
...hboard/consultant/[consultantId]/(features)/appointments/components/EventTimingsCalendar.tsx
Comment on lines +35 to +82
  const detectClassPlan = (plan: any) => {
    const title: string = (plan?.title || "").toString().toLowerCase();
    if (title.includes("comprehens")) return "Comprehensive" as const;
    if (title.includes("extended")) return "Extended" as const;
    if (title.includes("basic")) return "Basic" as const;
    return "Custom" as const;
  };

  const deriveClassNumbers = (plan: any) => {
    const type = detectClassPlan(plan);
    const classesPerWeekFromPlan = plan?.classesPerWeek ?? plan?.callsPerWeek;
    const durationInMonthsFromPlan = plan?.durationInMonths;
    const sessionDurationInHours = plan?.sessionDurationInHours ?? 1;

    let classesPerWeek = classesPerWeekFromPlan;
    let durationInMonths = durationInMonthsFromPlan;

    if (
      classesPerWeek === undefined ||
      classesPerWeek === null ||
      Number.isNaN(Number(classesPerWeek))
    ) {
      classesPerWeek =
        type === "Basic"
          ? 2
          : type === "Extended"
            ? 3
            : type === "Comprehensive"
              ? 4
              : 2;
    }
    if (
      durationInMonths === undefined ||
      durationInMonths === null ||
      Number.isNaN(Number(durationInMonths))
    ) {
      durationInMonths =
        type === "Basic"
          ? 1
          : type === "Extended"
            ? 2
            : type === "Comprehensive"
              ? 4
              : 1;
    }

    return { type, classesPerWeek, durationInMonths, sessionDurationInHours };
  };
Contributor
@gemini-code-assist gemini-code-assist bot 3 minutes ago
medium

The logic to derive class plan details from the plan's title string is a bit fragile and could lead to issues if titles are changed or don't follow the expected pattern. While this might be necessary for handling legacy data, it would be more robust to rely on explicit fields in the ClassPlan model.

Since you've already added sessionDurationInHours to the ClassPlan schema, I'd recommend ensuring that callsPerWeek and durationInMonths are also treated as the source of truth, and perhaps adding a planType enum field to the model to avoid relying on string matching in the title. This would make the system more maintainable and less prone to errors in the long run.

Reply...