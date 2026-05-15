# 0-org-lifecycle — UI: org creation wizard

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `app/dashboard/org-workspace/[orgWorkspaceId]/create/page.tsx` — wizard entry
- 5 wizard steps: identity, capability, funding, branding, review
- Posts to `POST /api/organizations` (covered by API file)

**Case roster:**
1. **WZ.1** — Happy path: Sponsor + INVOICE, all 5 steps
2. **WZ.2** — Capability gate: INERT (both off) → next button disabled / inline error
3. **WZ.3** — Slug clash on identity step → inline 409 message
4. **WZ.4** — Sub-MANAGER user navigating to `/create` → 403 / redirect
5. **WZ.5** — Branding upload (logo) → preview + persisted URL after submit

---

## Common preconditions

Promote a test user to `UserRole.ORG_WORKSPACE` per shared-setup §7.
Log in via Chrome MCP (see `mcp-recipes.md §Login-as-OWNER`).

---

## Case WZ.1: Happy path — Sponsor + INVOICE

### Steps
1. `navigate_page("http://localhost:3000/dashboard/org-workspace/<id>/create")`
2. `take_snapshot()`
3. **Step 1 (Identity):** `fill_form` name + slug. Click "Next."
4. **Step 2 (Capability):** select Sponsor only. Click "Next."
5. **Step 3 (Funding):** select INVOICE. Click "Next."
6. **Step 4 (Branding):** skip (or upload via WZ.5). Click "Next."
7. **Step 5 (Review):** verify the summary matches steps 1-4. Click "Create."
8. `wait_for({ text: "PENDING_VERIFICATION" })` or `wait_for({ text: "<org-name>" })`

### Assertions
- URL navigates to `/dashboard/organization/<new-org-id>/home`.
- DB: org row exists with the inputs from steps 1-3.
- Audit log: `ORG_CREATED`.

---

## Case WZ.2: INERT rejection at the capability step

Repeat WZ.1 but at Step 2, leave both capability toggles off.

### Assertions
- "Next" button is disabled OR clicking it surfaces an inline error.
- `take_snapshot` shows the error text.
- No POST to `/api/organizations` is sent (verify via
  `list_network_requests`).

---

## Case WZ.3: Slug clash

At Step 1, type a slug that already exists (`wipro`). Click "Next."

### Assertions
- Inline error: "Slug already taken" or similar.
- The wizard stays on Step 1.
- No POST is sent.

---

## Case WZ.4: Sub-MANAGER user navigating to /create

Login as a `LEARNER` or `MANAGER` (not OWNER, not `ORG_WORKSPACE`).
`navigate_page` to the wizard.

### Assertions
- 403 page or redirect to `/dashboard`.
- `take_snapshot` shows access-denied chrome.
- No `/api/organizations` POST is fired even if the user manually fills the form.

---

## Case WZ.5: Logo upload preview

At Step 4 (Branding), upload a small valid PNG via the file input.

### Steps
- Use `mcp__chrome-devtools__upload_file` to attach a fixture image.
- `wait_for` the preview thumbnail to render.

### Assertions
- The preview shows the uploaded image.
- After submitting the wizard, the org's `logo` column points to a Supabase
  storage URL:
  ```sql
  SELECT logo FROM "organizations" WHERE id = '<new-org-id>';
  -- Expected: a string URL (Supabase storage path or signed URL)
  ```
- Audit log: an entry referencing branding (`BRANDING_UPLOADED`).
