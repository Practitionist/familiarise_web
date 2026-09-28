# Server Data and Validation

The rule: **the write path is the only boundary that counts.**

Everything in this file exists because a client-side check was the only check.

---

## 1. A browser check is not validation

Client validation is for the user's experience. It is bypassable by anyone with
devtools, a script, or a replayed request. Never let it be the _only_ thing
between input and the database.

The real example, from consultant verification ([#1869](https://github.com/Practitionist/familiarise_web/issues/1869)):

| Layer                  | Rule                                      | Accepts             |
| ---------------------- | ----------------------------------------- | ------------------- |
| Wizard component       | anchored `linkedin.com/in/<handle>` regex | only a real profile |
| Onboarding form schema | `z.string().url()`                        | `https://evil.test` |
| **Server schema**      | **`z.string().optional()`**               | **`"banana"`**      |

The user was told _"that's not a valid LinkedIn URL"_, and the identical value
posted cleanly if the browser check was skipped. That value was the identity
claim an admin reviews to approve a payout.

**How to apply:** for anything that gates trust, money, or access, the check
belongs in the server schema or the write helper. If you add a strict client
check, ask where the server copy is.

---

## 2. Never trust client-supplied file metadata

The upload route is a good example of doing this right, and worth copying
verbatim in spirit:

- **Allowlist the type.** `ALLOWED_TYPES` in
  `app/api/verification/documents/route.ts` is png/jpeg/jpg/webp/pdf.
- **Do not trust `Content-Type`.** It is trivially spoofable, which is why the
  route calls `normalizeDeclaredMime` to sniff the actual bytes. This is the
  OWASP File Upload Cheat Sheet's central point.
- **Cap the size.** `MAX_FILE_SIZE = 10 * 1024 * 1024`.
- **Generate the storage filename yourself.** `generateStorageFileName(mimeType)`,
  never the user's name.
- **Persist only server-issued ids.** See below.

---

## 3. Persist only server-issued ids — the rule that closes id injection

`lib/verification/submit-request.ts` links documents like this:

```ts
const linked = await tx.profileVerificationDocument.updateMany({
  where: {
    id: { in: documentIds },
    uploadedByUserId: input.userId, // ownership
    verificationId: null, // single use
  },
  data: { verificationId: created.id, linkedAt: new Date() },
});
if (linked.count !== documentIds.length) {
  throw new SubmitRefused("DOCUMENTS_NOT_OWNED", "...");
}
```

Three properties in one query, and the **count check is what makes it sound** — a
`where`-only filter silently succeeds when it matches fewer rows than you asked
for. `documentIds` is also de-duplicated (`Array.from(new Set(...))`) first, so
the comparison is against the real intent.

The client sends a whole object per document — `fileUrl`, `storagePath`,
`fileSize`, `mimeType` — and **none of it is persisted**. Only `id` is read.
`isPersistableVerificationDoc` enforces that: a real server-issued id, and never
an `isOnboardingUpload` draft.

**How to apply:** if you accept a list of client references to server rows,
scope the write by owner, and assert the affected-row count matches what you
asked for. Never trust client-supplied URLs, paths, or sizes.

---

## 4. `z.any()` in a schema is a lie, not a safety valve

`verificationDocuments: z.array(z.any()).optional()` appeared in both onboarding
schemas. Nothing was insecure — the enforcement was correctly one layer down —
but the schema claimed to validate something it did not. Three costs:

1. Client `safeParse` can never surface a field error, so the user gets silence
   instead of a message.
2. The array is unbounded. ASVS **V5.2.4** wants a per-user file cap; an
   unbounded array is a cheap payload-amplification vector.
3. A hand-written TS interface alongside the schema can drift from it silently.

**How to apply:** describe the real shape, `.max()` the array, and derive the
TypeScript type with `z.infer` instead of writing it by hand.

---

## 5. Reuse one rule, don't re-derive it per surface

The LinkedIn bug existed because four different rules applied to one field in
four different files. A profile form, an onboarding wizard, a settings tab, and
a server write each had their own opinion.

**How to apply:** export the canonical schema once and have every surface
extend it. When you add a surface that validates a field, the question is
"which existing rule am I reusing?" — if the answer is none, that is a smell.

---

## 6. Validate the parse, then branch on `success`

```ts
const result = Schema.safeParse(input);
if (!result.success) {
  return { ok: false, fieldErrors: result.error.flatten().fieldErrors };
}
```

Read `result.error`. Branching on a value you destructured _before_ validating
means reading `undefined` on the failure path and reporting a nonsense error.
Two of the onboarding review findings were exactly this shape.
