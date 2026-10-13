# Server Actions vs API Routes

This is a thin index. The substance already exists and is good — do not duplicate
it here.

**Read:** [`docs/education/server-actions-vs-api-routes.md`](../../education/server-actions-vs-api-routes.md)

That document covers when to reach for each and how to choose. What follows is
only the frontend-specific consequence, which that doc does not address.

---

## The frontend question is not "which is better"

It is **"what does the caller need?"**

- **Server action** — a mutation invoked by _your own_ React code, where the
  ergonomics matter: types flow end to end, the framework handles the transport,
  and the page re-renders on return.
- **API route** — anything that needs a **stable HTTP contract**: the mobile app,
  a webhook, a cron over HTTP, a third party, or a multipart upload.

The second list is the real discriminator, and it is _not_ "called by React vs
not" — because React can call a route perfectly well.
`ConsultantVerificationForm` does exactly that, posting `FormData` to
`/api/verification/documents`. That is the right call: a file upload wants the
durable, CSRF-guarded, size-limited route boundary, and wants a path that is not
tied to a generated action id.

The onboarding steps use server actions, correctly, because they are plain
mutations from the wizard and the type safety is the point.

## A server action is a POST endpoint — authenticate it like one

This is the mistake worth naming, because the ergonomics actively disguise it.

A Server Action is exposed as a **POST endpoint** at a build-generated path.
Your rendered code calls it directly, which makes it _feel_ internal and
inaccessible. It is not. Anything that can reach that URL can invoke it, so:

> **Every server action performs its own authentication and authorisation
> checks.** Treat it exactly like a route handler. The absence of an
> `Authorization` header in the call site is not a security control.

`actions/forms/onboarding.action.ts` opens every entry point with
`getSession()`. That is not ceremony — it is the control.

What an action genuinely does _not_ give you is a **stable, documented HTTP
contract** for a third party to integrate against. That, plus multipart, caching
headers, and webhook semantics, is what should push you to a route.

Server actions also get **end-to-end type propagation for their signature** — a
well-typed argument and return value are checked at the call site and at build
time, and a change to either breaks the client build. That is a real benefit and
it is why a route's untyped wire format needs its own validation at the edge.

**But a type is not a runtime validator, and type propagation does not validate
arguments for you.** Two things follow, and both bite:

- An argument typed `unknown` is a promise about the _caller's_ intent, not a
  check. `updateOnboardingInformationAction(userId, body: unknown)` takes
  `unknown` precisely because the body is a discriminated union the action must
  narrow at runtime.
- Changing a Zod schema cannot break a build through that signature, because
  nothing in the type mentions the schema. A schema change is enforced by
  **tests**, not by the compiler.

So: TypeScript stops you passing the wrong _shape_ to something typed. It stops
you passing the wrong _value_ to nothing. Untrusted input — a `body: unknown`, a
`request.json()`, a search param — needs `safeParse` at the boundary, whatever
the signature claims. This is the structural reason
[01-server-data-and-validation.md](./01-server-data-and-validation.md) leans so
hard on validating at the write boundary.

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
