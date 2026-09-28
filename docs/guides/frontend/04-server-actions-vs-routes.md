# Server Actions vs API Routes

This is a thin index. The substance already exists and is good — do not duplicate
it here.

**Read:** [`docs/education/server-actions-vs-api-routes.md`](../../education/server-actions-vs-api-routes.md)

That document covers when to reach for each and how to choose. What follows is
only the frontend-specific consequence, which that doc does not address.

---

## The frontend question is not "which is better"

It is **"who is the caller?"**

- **Server action** — called from _your own_ React code. A form submit, a
  mutation, a revalidation. The caller is a component you wrote and the framework
  handles the transport, the types, and the revalidation.
- **API route** — called by something that is _not_ your React code. The mobile
  app, a webhook, a cron over HTTP, a third party.

`app/api/verification/documents/route.ts` is an API route, not a server action,
and that is correct: the upload is multipart from a component but the route is
also the durable, CSRF-guarded, size-limited boundary. The onboarding steps use
server actions, correctly, because the caller is the wizard.

## Consequences you inherit in the UI

- A server action is **only callable from your origin's rendered code.** A route
  is callable by anything. Anything holding a credential or a trust boundary
  wants the route.
- Server actions get **automatic type propagation** end to end, so a Zod schema
  change breaks the client at build time. A route's payload is an untyped wire
  format, so it needs its own validation at the edge. This is the structural
  reason [01-server-data-and-validation.md](./01-server-data-and-validation.md)
  leans so hard on validating at the write boundary — for routes, it is the only
  validation there is.
- Revalidation after a route is **your job**; after a server action it is
  automatic. If a route-backed mutation leaves stale UI, that is the bug.
