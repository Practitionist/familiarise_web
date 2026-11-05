# User Management

This document covers Stream Chat user management operations including user upsert, role mapping, user search, and background synchronization.

## Table of Contents

- [User Upsert Operations](#user-upsert-operations)
- [Role Mapping](#role-mapping)
- [User Search](#user-search)
- [Background Sync Job](#background-sync-job)

---

## User Upsert Operations

User upsert operations ensure that users in your Prisma database are synchronized with Stream Chat. These operations create or update users in Stream Chat with the latest information from your database.

### Single User Upsert

The `upsertUserToStream` function creates or updates a single user in Stream Chat.

**Location:** `/actions/stream/chat/user.action.ts`

**Function Signature:**

```typescript
export const upsertUserToStream = async (userId: string)
```

**Parameters:**

- `userId` (string): The unique identifier of the user to upsert

**Returns:**

- `Promise<UserResponse>`: The upserted user object from Stream Chat

**Example Usage:**

```typescript
import { upsertUserToStream } from "@/actions/stream/chat/user.action";

// Upsert a single user
try {
  const streamUser = await upsertUserToStream("user-123");
  console.log("User upserted:", streamUser);
} catch (error) {
  console.error("Failed to upsert user:", error);
}
```

**Internal Process:**

1. Validates Stream API credentials
2. Fetches user details from Prisma database (id, name, image, role; email is deliberately not selected)
3. Builds the Stream payload with `toStreamUser()` (`lib/stream/user-payload.ts`), which maps the role through `mapRoleToStream()` and returns only `id`, `name` (falling back to the id), `image` (omitted when empty) and `role`
4. Calls `client.upsertUser()` with that payload
5. Returns the Stream Chat user object

**Error Handling:**

- Throws error if Stream API keys are not configured
- Throws error if user is not found in database
- Logs and re-throws any Stream API errors

### Batch User Upsert

The `upsertUsersToStream` function creates or updates multiple users in a single operation for better performance.

**Location:** `/actions/stream/chat/user.action.ts`

**Function Signature:**

```typescript
export const upsertUsersToStream = async (userIds: string[])
```

**Parameters:**

- `userIds` (string[]): Array of user IDs to upsert

**Returns:**

- `Promise<UpsertManyUsersResponse>`: Batch upsert response from Stream Chat

**Example Usage:**

```typescript
import { upsertUsersToStream } from "@/actions/stream/chat/user.action";

// Upsert multiple users at once
try {
  const userIds = ["user-123", "user-456", "user-789"];
  const result = await upsertUsersToStream(userIds);
  console.log("Users upserted:", result);
} catch (error) {
  console.error("Failed to upsert users:", error);
}
```

**Internal Process:**

1. Validates Stream API credentials
2. Fetches all users from Prisma database using `findMany` with `where: { id: { in: userIds } }`
3. Maps each user's role to Stream Chat role
4. Transforms users into Stream Chat format
5. Calls `client.upsertUsers()` with batch payload
6. Returns batch upsert response

**Performance Benefits:**

- Single API call for multiple users
- Reduced network overhead
- Faster synchronization for bulk operations

---

## Role Mapping

Stream Chat uses a role-based permission system. The `mapRoleToStream` function maps application user roles to Stream Chat roles.

**Location:** `/lib/user.ts` — `mapRoleToStream`

### Least-Privilege Mapping

The mapping follows least privilege. Every account, platform staff and admins included, is mapped to the plain `user` role; nobody holds Stream's global `admin`. Instead, channel creation happens server-side and each host is given a channel-scoped `channel_moderator` grant on their own host channels at creation time, rather than a global moderation grant that would also cover peer direct-message channels.

### Operators are plain Stream users

Stream's `admin` role bypasses channel permission checks, so an operator token
could read any private DM from the browser with no audit. Operators therefore
hold `user` like everyone else, and `chatTokenProvider` / `tokenProvider` mint
only for the caller (no role is exempt). Every staff chat action goes through
server routes that use the API-secret clients in `lib/stream-client.ts` and are
audited there; no operator surface reads channels in the browser.

The role is written at upsert time (`upsertUserToStream` /
`upsertUsersToStream` in `actions/stream/chat/user.action.ts`), so a Stream user
upserted while operators mapped to `admin` keeps that role until re-upserted.

### The Familiarise Support service user

`familiarise-support` (`lib/stream/support-user.ts`) is the one Stream user
with no `User` row. It holds `user`, never logs in and never gets a token. A
case-linked intervention adds it as a visible member of the booking chat with a
`type: "system"` join message; staff post as it through
`POST /api/support/cases/[caseId]/chat/messages`, and it leaves (with a system
message) when the grant ends or the case resolves. The chat banner reads its
membership, so there is no channel extra data to keep in sync.

### Server-only system users

`system-booking-context` (`LEGACY_BOOKING_CONTEXT_USER_ID` in `lib/stream/system-users.ts`) is a Stream user with no `User` row that never gets a token. Nothing posts as it any more; it authored the retired booking cards, which `components/chat/CustomMessage.tsx` now hides, and `GET /api/stream/booking-tag` ignores it when counting a DM's members. The `system-` prefix is load-bearing: the `stream-sync` user deletion and the daily membership reconciler (`lib/stream/membership-reconciler.ts`) both leave `system-` users and the Familiarise Support user alone.

### Revoking a removed member's access

When an organization removes a member, `revokeMemberStreamAccess` (`lib/enterprise/member-removal.ts`) calls `revokeUserToken` with a cutoff, so every Stream token issued before the removal stops working. The wind-down drain (`jobs/stream/wind-down-deactivated-orgs.ts`) passes the membership's `updatedAt` as the cutoff, so a re-run never revokes a token minted after the member rejoined. The result's `tokenRevoked` flag now reflects whether the call succeeded, and an incomplete revocation queues an `ORG_REVOKE` row for the `retry-moderation-enforcement` sweep. The member's own browser recovers by itself: the SDK asks its token provider again only to replace a token Stream refused, and `sdkTokenProvider` in `providers/StreamProviderImpl.tsx` skips the token cache on every such re-request after the first, so a user Postgres still admits gets a fresh token and a removed user does not.

### Rollout: downgrade existing operator roles

**Owner end-phase step, run by hand once after deploy. It is not a script.** An
operator can connect without triggering the upsert, so their stored `admin`
role has to be cleared server-side:

1. List the operator ids read-only:
   `SELECT id FROM "User" WHERE role IN ('ADMIN', 'STAFF');`
2. For each id, partial-update the Stream user to `role: "user"` (Stream
   dashboard, or `users_update_partial` with `set: { role: "user" }`), then
   revoke their tokens (`revokeUserToken(id, new Date())`) so sessions minted
   under `admin` drop.
3. Verify that `query_users` with `{ role: { $eq: "admin" } }` returns no users.

### Current Implementation

**Function Signature:**

```typescript
export function mapRoleToStream(_role: string | null | undefined): string;
```

**Parameters:**

- `role` (string | null | undefined): The application user role

**Returns:**

- `string`: The Stream Chat role — always `user`

**Current Behavior:**

```typescript
export function mapRoleToStream(_role: string | null | undefined): string {
  return "user";
}
```

### Standard Stream Chat Roles

Stream Chat provides the following standard roles:

| Role        | Permissions                                                          |
| ----------- | -------------------------------------------------------------------- |
| `admin`     | Full permissions (create, read, update, delete channels)             |
| `user`      | Basic user permissions (may not have team channel access by default) |
| `guest`     | Limited permissions                                                  |
| `anonymous` | Very limited permissions                                             |

### Channel-Scoped Moderation

Consultants are mapped to the plain `user` role globally and instead receive a channel-scoped `channel_moderator` grant on their own host channels at creation time. This gives a host moderation authority over the channels they own without granting global admin permissions or moderation rights over unrelated peer direct-message channels.

---

## User Search

The application provides two user search functions with different capabilities.

### Enhanced Search with Relationships

The `searchUsersWithRelationships` function searches for users and includes relationship status information based on appointments.

**Location:** `/actions/stream/chat/user.action.ts` (lines 125-201)

**Function Signature:**

```typescript
export const searchUsersWithRelationships = async (
  searchTerm: string,
  currentUserId: string
)
```

**Parameters:**

- `searchTerm` (string): Search query to match against name or email
- `currentUserId` (string): The current user's ID (excluded from results)

**Returns:**

```typescript
Promise<
  Array<{
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    role: string;
    hasRelationship: boolean;
  }>
>;
```

**Example Usage:**

```typescript
import { searchUsersWithRelationships } from "@/actions/stream/chat/user.action";

// Search for users and check relationships
const users = await searchUsersWithRelationships("john", "current-user-id");

users.forEach((user) => {
  console.log(
    `${user.name} - ${user.hasRelationship ? "Connected" : "Not connected"}`,
  );
});
```

**Features:**

- **Relationship Detection:** Checks if users have existing appointments or subscriptions
- **Smart Sorting:** Connected users appear first, then sorted alphabetically
- **System User Exclusion:** Automatically filters out system users
- **Case-Insensitive Search:** Matches name or email regardless of case

**Exclusion Rules:**

```typescript
NOT: [
  { id: { startsWith: "recording-egress-" } },
  { id: { startsWith: "system-" } },
];
```

**Relationship Types Checked:**

1. **Consultations:** APPROVED or SCHEDULED status
2. **Subscriptions:** APPROVED or SCHEDULED, with valid end dates
3. **Shared Appointments:** Users in the same webinar or class slots

**Performance:**

- Limit: 20 results
- Uses Prisma's `findMany` with indexed fields
- Parallel relationship checking with `Promise.all`

### Legacy Search

The `searchUsers` function provides basic user search without relationship information.

**Location:** `/actions/stream/chat/user.action.ts` (lines 384-431)

**Function Signature:**

```typescript
export const searchUsers = async (searchTerm: string)
```

**Parameters:**

- `searchTerm` (string): Search query to match against name or email

**Returns:**

```typescript
Promise<
  Array<{
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    role: string;
  }>
>;
```

**Example Usage:**

```typescript
import { searchUsers } from "@/actions/stream/chat/user.action";

// Simple user search
const users = await searchUsers("jane");
console.log(`Found ${users.length} users`);
```

**Features:**

- Simpler and faster than relationship search
- Same exclusion rules for system users
- Limit: 10 results
- Alphabetical sorting by name

**Use Cases:**

- Use `searchUsersWithRelationships` for Direct Message dialogs where connection status matters
- Use `searchUsers` for general admin searches or when performance is critical

---

## Background Sync Job

`performStreamUserSync` in `scripts/stream/stream-sync.ts` compares up to five
100-user Stream pages against database ownership. The ticker queues its native
background worker at 08:50, 09:50 and 10:50 UTC. Cleanup and staff recovery queue
the same worker; 202 proves admission, while execution history records completion.
The former Actions wrapper and schedule are removed. Automatic background
execution currently requires Netlify as active cron host.

The core uses a fail-closed 15-minute Postgres lease, retains an ID checkpoint,
and wraps at the end of the provider roster. Dry runs preserve the starting
checkpoint. Active database users are retained; absent users receive soft-delete
requests; erased users receive hard-delete requests. Support/system principals,
reserved prefixes and the configured exclusion list remain exempt. There is no
additional 30-day grace rule in this core.

On every page it already reads, the job also removes contact data that older
upserts stored at Stream. `staleContactFields()` (`lib/stream/user-payload.ts`)
names the fields in `STREAM_CONTACT_FIELDS` (today `email`) that a user still
carries, and one `partialUpdateUsers` call per page unsets them. Users already
deleted in Stream or queued for hard delete are skipped, a dry run only counts,
and a clean roster produces no writes. This costs no extra Stream reads and also
catches any future regression that stores a contact field again. See the
[Stream user allowlist decision](../decisions/2026-11-05-stream-user-allowlist.md).

`SyncSummary` exposes processed/identified counts, accepted deletion-request
counts, failed entries, asynchronous task IDs, `checkpoint`, `hasMore`,
`totalContactFieldsScrubbed` and `totalFailedScrubs`. A failed scrub sets
`success` to false and is logged once per run, not once per user. It also
ends the run with the checkpoint held at the start of the failed page, so the
next run replays that page; the scrub runs before the page's deletions, so a
replay never resends a deletion request.
Accepted requests do not prove asynchronous hard-delete completion. Dedicated
erasure obligations retain their own retry owner. DeleteUsers requests remain
paced at least ten seconds apart by default, including across soft/hard modes;
a five-page slice is not full-roster coverage.

Use authenticated `POST /api/cleanup/stream-sync` (optional `?dry-run=true`) or
the staff system-jobs door. The worker needs database, Stream and cron-auth
configuration in the deployment environment; Redis is not its mutual-exclusion
store. See [background recovery](./09-background-sync.md) for failure semantics,
completion health, limits, host portability and deployment verification.

---

## Related Documentation

- [Token Management](./08-token-management.md)
- [Background Sync](./09-background-sync.md)
- [API Endpoints](./10-api-endpoints.md)

---

## Deprecated & Superseded Approaches

- **Global `admin` Role Mapping**: Every account once mapped to Stream `admin`, later only `ADMIN`/`STAFF` did, alongside an operator bypass for minting tokens for other users. Superseded by mapping every account to `user` and self-only minting, because both paths gave operators silent, unaudited browser reads of any chat.
- **Email in Stream User Metadata**: The upserts sent `email` to Stream until the allowlist change, so channel co-members could read it. `stripStreamUserEmails` only ever stripped responses from our server actions, never what Stream stored. Superseded by `toStreamUser()`, which never carries email, and by the `stream-sync` scrub of older copies. `droppedIds` consent filtering (`STREAM_DATA_PROCESSING`) is separate and unchanged.
- **Token Revocation Reported but Never Performed**: `revokeMemberStreamAccess` once returned `tokenRevoked: false` without revoking anything, so a removed member's token lived until it expired. It now revokes tokens issued before the removal.
- **Ad-Hoc Account Scrubbing**: Superseded by `eraseStreamPrincipalFootprint` (`lib/compliance/erasure/scrub-user.ts`) with retry persistence (`StreamRevocationRetry`).
