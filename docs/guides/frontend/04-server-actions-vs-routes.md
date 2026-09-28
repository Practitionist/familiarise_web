# Server Actions vs API Routes

This is a thin index. The substance already exists and is good — do not duplicate
it here.

**Read:** [`docs/education/server-actions-vs-api-routes.md`](../../education/server-actions-vs-api-routes.md)

That document covers when to reach for each and how to choose. What follows is
only the frontend-specific consequence, which that doc does not address.

---

## The frontend question is not "which is better"

It is **"who is the caller?"**

- **Server action** — invoked by _your own_ React code. A form submit, a
  mutation, a revalidation. Rendered code calls it conveniently and the
  framework handles the transport and the types.
- **API route** — invoked by something that is _not_ your React code. The mobile
  app, a webhook, a cron over HTTP, a third party.

`app/api/verification/documents/route.ts` is an API route, not a server action,
and that is correct: the upload is multipart from a component but the route is
also the durable, CSRF-guarded, size-limited boundary. The onboarding steps use
server actions, correctly, because the caller is the wizard.

## A server action is a POST endpoint — authenticate it like one

This is the mistake worth naming, because the ergonomics actively disguise it.

A Server Action is exposed as a **POST endpoint** at a build-generated path.
Your rendered code calls it directly, which makes it _feel_ internal and
inaccessible. It is not. Anything that can reach that URL can invoke it, so:

> **Every server action performs its own authentication and authorisation
> checks.** Treat it exactly like a route handler. The absence of an
> `Authorization` header in the call site is not a security control.

`actions/forms/onboarding.action.ts` opens every entry point with
`getSession(true)`. That is not ceremony — it is the control.

What an action genuinely does _not_ give you is a **stable, documented HTTP
contract** for a third party to integrate against. That, plus multipart, caching
headers, and webhook semantics, is what should push you to a route.

Server actions also get **end-to-end type propagation**, so a Zod schema change
breaks the client at build time. A route's payload is an untyped wire format, so
it needs its own validation at the edge. That is the structural reason
[01-server-data-and-validation.md](./01-server-data-and-validation.md) leans so
hard on validating at the write boundary — for a route, it is the only validation
there is.

## Revalidation: partly automatic, and the gap is where stale UI comes from

This is subtle enough that both extremes are wrong, so here is the whole
picture.

- After a server action runs, Next.js returns an **updated RSC payload for the
  current route**, so the page you are on re-renders with fresh data in the same
  round trip. That part _is_ automatic.
- Cached data **outside** that round trip is not touched. The Data Cache
  (`fetch` / `unstable_cache`) and any other route holding the same data keep
  serving what they had. Invalidating that needs an explicit
  `revalidatePath`, `revalidateTag`, or equivalent.
- After a **route handler**, nothing is automatic at all — the response is just
  a response, and the client has to refetch or the router has to refresh.

So the practical rule: a route-backed mutation that leaves stale UI is a bug you
have to fix by refetching or revalidating; an action-backed one is only stale
across _other_ routes or through the Data Cache. If you are chasing stale data
after an action, the answer is `revalidatePath`/`revalidateTag`, not a refresh.
