# Google Cloud Platform — Auth & OAuth Reference Guide

> Written for junior developers maintaining Familiarise's GCP configuration.
> Covers everything we learned debugging Google OAuth, including the wrong-client-ID
> incident and how we resolved it.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [GCP Console Navigation](#gcp-console-navigation)
3. [The Wrong Client ID Incident](#the-wrong-client-id-incident)
4. [OAuth 2.0 Client Configuration](#oauth-20-client-configuration)
5. [APIs That Must Be Enabled](#apis-that-must-be-enabled)
6. [gcloud CLI Setup & Verification](#gcloud-cli-setup--verification)
7. [BetterAuth Integration](#betterauth-integration)
8. [How to Add a New Environment](#how-to-add-a-new-environment)
9. [Gotchas, Errors & Debugging Log](#gotchas-errors--debugging-log)
10. [Quick Reference](#quick-reference)

---

## Project Overview

| Property           | Value                                                               |
| ------------------ | ------------------------------------------------------------------- |
| GCP Project ID     | `familiarise`                                                       |
| GCP Project Number | `384845845365`                                                      |
| Billing account    | Linked to `<team-admin-email>`                                      |
| GCP Console        | `https://console.cloud.google.com/?project=familiarise`             |
| Auth Platform      | `https://console.cloud.google.com/auth/clients?project=familiarise` |
| OAuth brand        | `familiarise`                                                       |

### OAuth clients in this project

| Name                     | Type            | Client ID (prefix)     | Purpose                          |
| ------------------------ | --------------- | ---------------------- | -------------------------------- |
| `familiarise-web-client` | Web application | `384845845365-8eac...` | **Primary — production website** |
| `familiarise-mac`        | Desktop         | `384845845365-42ti...` | macOS desktop app (future)       |
| `Android client 1`       | Android         | `384845845365-6bg1...` | Android app (future)             |
| `iOS client 1`           | iOS             | `384845845365-cbj7...` | iOS app (future)                 |

> **Only `familiarise-web-client` is relevant to the web app deployment.**
> Do not edit the other clients unless you are working on mobile/desktop.

---

## GCP Console Navigation

The GCP console was redesigned in 2025. The old path "APIs & Services → Credentials"
now lives under a new top-level section called **Google Auth Platform**.

**New path to OAuth clients:**

```
console.cloud.google.com → Google Auth Platform → Clients
```

Or directly:

```
https://console.cloud.google.com/auth/clients?project=familiarise
```

The old path (`APIs & Services → Credentials`) may redirect you to the new one
or show a legacy view — prefer the new URL above.

---

## The Wrong Client ID Incident

This is the most important section in this document. Read it carefully.

### What happened

When the deployment team audited the Netlify environment variables, they found:

```
GOOGLE_CLIENT_ID="<OLD_GOOGLE_CLIENT_ID>"
GOOGLE_CLIENT_SECRET="<OLD_GOOGLE_CLIENT_SECRET>"
```

These credentials were in both the local `.env` file and the Netlify dashboard.
They had been there since at least December 2024.

### Why this is wrong

The client ID prefix (the number before the first `-`) is a **GCP project number**. Every Google
OAuth 2.0 client ID starts with the project number of the GCP project it
belongs to.

The actual GCP project for Familiarise has project number `$GCP_PROJECT_NUMBER`.
So `<OLD_GOOGLE_CLIENT_ID>` belongs to a **completely different, unknown GCP project**.

```
Wrong:   <OLD_GOOGLE_CLIENT_ID>    ← alien project  (prefix ≠ 384845845365)
Correct: <google-client-id-prefix> ← familiarise project (prefix = $GCP_PROJECT_NUMBER)
```

The correct client is `familiarise-web-client` under the `familiarise` GCP project.

### Why no one noticed

**Email/password login was working.** BetterAuth handles email/password
authentication entirely internally — it never touches Google OAuth. So any user
(including the dev team and interns) who signed in with email + password had
a perfectly working session.

Google OAuth sign-in (`Sign in with Google` button) would have silently failed
for anyone who tried it — but since the dev team primarily used seed accounts
(email/password), the bug went undetected.

### How we found it

While investigating the `"invalid origin"` error on production (a separate bug
caused by `BETTER_AUTH_URL=localhost`), we audited all Netlify env vars as JSON:

```bash
netlify env:list --json
```

The `GOOGLE_CLIENT_ID` prefix didn't match the GCP project number
`384845845365` visible in the GCP Console URL bar. This mismatch led us to
open the GCP Console and discover the correct client.

### The fix

1. Opened GCP Console → Google Auth Platform → Clients
2. Identified `familiarise-web-client` (Web application type, created Aug 17 2025)
3. Opened the client and copied the full Client ID
4. Generated a new Client Secret (the old one from the alien project was useless)
5. Updated Netlify env vars:
   ```bash
   netlify env:set GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
   netlify env:set GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
   ```
6. Updated local `.env` with the same values

### The lesson

> **Always verify that the numeric prefix of `GOOGLE_CLIENT_ID` matches
> the GCP project number shown in the console URL (`project=NNNNNNNNNN`).
> A mismatch means you are using credentials from the wrong project.**

---

## OAuth 2.0 Client Configuration

### Client: `familiarise-web-client`

| Field                | Value                               |
| -------------------- | ----------------------------------- |
| Full Client ID       | `$GOOGLE_CLIENT_ID`                 |
| Type                 | Web application                     |
| Created              | August 17, 2025                     |
| Client secret suffix | `****TyRB` (created March 15, 2026) |

### Authorized JavaScript Origins

These are the domains where your frontend JavaScript runs. Google checks that
the sign-in request comes from one of these origins.

| URI                               | Purpose                |
| --------------------------------- | ---------------------- |
| `http://localhost:3000`           | Local development      |
| `https://familiarise.netlify.app` | Netlify default domain |
| `https://familiarisenow.com`      | Production             |
| `https://dev.familiarisenow.com`  | Dev branch staging     |

> **Rule:** Add an origin for every domain where your frontend is deployed.
> Do NOT add backend URLs (Supabase, APIs, etc.) — these are not JavaScript origins.
> Do NOT add `https://localhost:3000` — localhost must use `http://`.

### Authorized Redirect URIs

These are the exact URLs Google will redirect to after the user grants permission.
The path must match exactly what BetterAuth sends in the OAuth request.

| URI                                                        | Purpose                |
| ---------------------------------------------------------- | ---------------------- |
| `http://localhost:3000/api/auth/callback/google`           | Local development      |
| `https://familiarise.netlify.app/api/auth/callback/google` | Netlify default domain |
| `https://familiarisenow.com/api/auth/callback/google`      | Production             |
| `https://dev.familiarisenow.com/api/auth/callback/google`  | Dev branch staging     |

> **Critical path detail:** The path is `/api/auth/callback/google` — not
> `/auth/callback`, not `/api/auth/google/callback`.
> BetterAuth uses the pattern `/api/auth/callback/{provider}`.
> Getting this wrong causes `redirect_uri_mismatch` errors from Google.

### Previous incorrect redirect URIs (removed)

The old configuration had these entries — all wrong:

| Old URI                                                      | Why it was wrong                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `http://localhost:3000/auth/callback`                        | Wrong path — missing `/api/` prefix                                        |
| `https://familiarise.com/auth/callback`                      | Wrong domain (`familiarise.com` ≠ `familiarisenow.com`) AND wrong path     |
| `https://familiarise.netlify.app/auth/callback`              | Wrong path                                                                 |
| `https://<supabase-project-id>.supabase.co/auth/v1/callback` | Supabase Auth callback from before BetterAuth migration — completely wrong |

The Supabase entry (`/auth/v1/callback`) was a remnant of the previous auth
architecture that used Supabase's built-in auth instead of BetterAuth.
It was harmless but misleading and has been removed.

---

## APIs That Must Be Enabled

For Google OAuth sign-in to work, the following APIs must be enabled
in the `familiarise` GCP project:

| API                           | Status      | Purpose                                                            |
| ----------------------------- | ----------- | ------------------------------------------------------------------ |
| `people.googleapis.com`       | ✅ ENABLED  | Fetch user's name, email, profile photo after sign-in              |
| Google Auth Platform (OAuth2) | ✅ Built-in | Core OAuth2 flow — always active, not a separately-toggled service |

### How to verify via gcloud

```bash
# Add gcloud to your PATH first (see CLI setup below)
gcloud config set project familiarise

# Check People API
gcloud services list --enabled --filter="name:people.googleapis.com"

# Or check via REST
TOKEN=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://serviceusage.googleapis.com/v1/projects/$GCP_PROJECT_NUMBER/services/people.googleapis.com" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('State:', d.get('state'))"
```

### How to enable an API if it's disabled

```bash
gcloud services enable people.googleapis.com --project=familiarise
```

---

## gcloud CLI Setup & Verification

### Installation location

gcloud is installed at `~/google-cloud-sdk/`. It is **not** on the system PATH
by default — you must either source your shell config or export the path manually.

```bash
# Option 1: Source the shell config (sets PATH permanently for the session)
source ~/.zshrc

# Option 2: Export manually for a one-off session
export PATH="$PATH:~/google-cloud-sdk/bin"
```

> **Gotcha:** In Claude Code (AI-assisted terminal sessions), `source ~/.zshrc`
> does NOT persist PATH changes across separate Bash tool calls because each
> call is a fresh shell. Always prepend `export PATH=...` to every gcloud command
> in scripts, or use the full path `~/google-cloud-sdk/bin/gcloud`.

### Authentication

```bash
# Check who you're logged in as
gcloud auth list

# Log in (opens browser)
gcloud auth login

# Get an access token (useful for raw REST API calls)
gcloud auth print-access-token
```

The active account should be `<team-admin-email>` (same as the Netlify/GCP account).

### Setting the default project

```bash
gcloud config set project familiarise

# Verify
gcloud config get-value project
```

### Useful verification commands

```bash
# Confirm the project exists and is active
gcloud projects describe familiarise

# List all enabled APIs
gcloud services list --enabled --project=familiarise

# List auth-related enabled APIs
gcloud services list --enabled --project=familiarise \
  --filter="name:(people OR auth OR identity OR oauth)"
```

### Why `gcloud alpha iap oauth-clients list` doesn't work here

We tried listing OAuth clients via the IAP (Identity-Aware Proxy) API:

```bash
gcloud alpha iap oauth-clients list "projects/$GCP_PROJECT_NUMBER/brands/$GCP_PROJECT_NUMBER"
```

This failed with `SERVICE_DISABLED` because **IAP is a separate product**
(for securing internal Google Cloud apps) and is not used by Familiarise.
Our OAuth clients are standard "Google Auth Platform" clients, not IAP clients.

There is no public gcloud or REST API to read the `Authorized JavaScript origins`
or `Authorized redirect URIs` of an OAuth 2.0 web client — these can only be
viewed and edited through the GCP Console UI. Verification must be done visually.

### What you CAN verify via CLI

```bash
export PATH="$PATH:~/google-cloud-sdk/bin"
TOKEN=$(gcloud auth print-access-token)

# 1. Confirm the client ID belongs to this project
#    The numeric prefix of the client ID must match the project number
CLIENT_ID="$GOOGLE_CLIENT_ID"
echo "Client prefix: $(echo $CLIENT_ID | cut -d'-' -f1)"   # should print $GCP_PROJECT_NUMBER

# 2. Confirm the project is active
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://cloudresourcemanager.googleapis.com/v1/projects/familiarise" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['projectId'], d['lifecycleState'])"

# 3. Confirm People API is enabled
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://serviceusage.googleapis.com/v1/projects/$GCP_PROJECT_NUMBER/services/people.googleapis.com" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('People API:', d.get('state'))"
```

---

## BetterAuth Integration

### How BetterAuth uses the Google credentials

In `lib/auth.ts`:

```typescript
socialProviders: {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },
},
```

BetterAuth handles the full OAuth2 PKCE flow:

1. User clicks "Sign in with Google"
2. BetterAuth redirects to `accounts.google.com/o/oauth2/auth` with:
   - `client_id` = `GOOGLE_CLIENT_ID`
   - `redirect_uri` = `{BETTER_AUTH_URL}/api/auth/callback/google`
   - `scope` = `openid email profile`
3. User consents on Google's page
4. Google redirects to `{BETTER_AUTH_URL}/api/auth/callback/google?code=...`
5. BetterAuth exchanges the code for tokens, fetches the user profile via People API
6. BetterAuth creates or updates the user record and sets the session cookie

### The callback route

The callback is handled by the catch-all BetterAuth route:

```
app/api/auth/[...all]/route.ts
```

This single file handles all BetterAuth routes including:

- `POST /api/auth/sign-in/email`
- `GET  /api/auth/callback/google`
- `GET  /api/auth/callback/github`
- `POST /api/auth/sign-out`
- etc.

### Environment variables required

| Variable               | Where set        | Value                                                                 |
| ---------------------- | ---------------- | --------------------------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Netlify + `.env` | `$GOOGLE_CLIENT_ID`                                                   |
| `GOOGLE_CLIENT_SECRET` | Netlify + `.env` | `$GOOGLE_CLIENT_SECRET`                                               |
| `BETTER_AUTH_URL`      | Netlify + `.env` | `https://familiarisenow.com` (prod) / `http://localhost:3000` (local) |

`BETTER_AUTH_URL` determines the `redirect_uri` that BetterAuth sends to Google.
If this is wrong, Google rejects the callback with `redirect_uri_mismatch`.

---

## How to Add a New Environment

If you deploy a new environment (e.g. `staging.familiarisenow.com`):

1. **GCP Console** → Google Auth Platform → Clients → `familiarise-web-client` → Edit
2. Add to **Authorized JavaScript origins**:
   ```
   https://staging.familiarisenow.com
   ```
3. Add to **Authorized redirect URIs**:
   ```
   https://staging.familiarisenow.com/api/auth/callback/google
   ```
4. Click **Save** and wait up to 5 minutes
5. Set Netlify env vars for the new branch:
   ```bash
   netlify env:set BETTER_AUTH_URL "https://staging.familiarisenow.com" --context branch-deploy
   ```

> **No new client ID or secret is needed.** One web client can serve unlimited
> origins and redirect URIs — just keep adding them to the same `familiarise-web-client`.

---

## Gotchas, Errors & Debugging Log

### 1. `redirect_uri_mismatch`

**Symptom:** Google OAuth returns an error page saying `redirect_uri_mismatch`
after the user approves the consent screen.

**Cause:** The `redirect_uri` BetterAuth sent to Google doesn't exactly match
any entry in "Authorized redirect URIs". Common causes:

- `BETTER_AUTH_URL` is set to `localhost` in production → generates a localhost
  redirect URI which isn't registered for production
- Path is wrong (e.g. `/auth/callback` instead of `/api/auth/callback/google`)
- Domain mismatch (`familiarise.com` vs `familiarisenow.com`)
- HTTP vs HTTPS mismatch

**Debug:** Check exactly what `redirect_uri` BetterAuth is sending by temporarily
logging it, or check the browser's network tab on the OAuth redirect request.
The URL will contain `redirect_uri=...` as a query parameter.

---

### 2. `invalid_client`

**Symptom:** OAuth flow fails immediately with `invalid_client` error.

**Cause:** `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is wrong.

**Debug checklist:**

- Verify the numeric prefix of `GOOGLE_CLIENT_ID` matches the GCP project number
- Verify the secret hasn't been rotated/deleted in GCP Console
- Verify the client type is "Web application" (not Desktop or Android)
- Run `netlify env:list --json | grep GOOGLE` to confirm what's deployed

---

### 3. Google OAuth works locally but fails in production

**Most common cause:** `BETTER_AUTH_URL` is set to `http://localhost:3000` in
Netlify env vars. This makes BetterAuth send `redirect_uri=http://localhost:3000/...`
to Google — which fails because that URI is not registered for the production domain.

**Fix:**

```bash
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context production
netlify env:set BETTER_AUTH_URL "https://familiarisenow.com" --context branch-deploy
```

---

### 4. `https://localhost:3000` in Authorized JavaScript Origins

**Symptom:** Sign-in popup fails with `origin_mismatch` even though localhost
is registered.

**Cause:** Localhost must use `http://`, not `https://`. A local dev server
runs on `http://localhost:3000` — there is no TLS cert for localhost by default.

**Fix:** Remove `https://localhost:3000` from origins. Keep only `http://localhost:3000`.

---

### 5. Supabase callback URI leftover

**Background:** Before BetterAuth, the project may have used Supabase's built-in
auth. Supabase uses `{SUPABASE_URL}/auth/v1/callback` as its OAuth callback.

After migrating to BetterAuth, this entry in the redirect URIs is dead weight.
It was found and removed during the audit. If you see any Supabase URLs in the
GCP OAuth config, they can safely be deleted.

---

### 6. `gcloud alpha` commands not available

**Symptom:** `gcloud alpha iap oauth-clients list` fails asking to install `alpha` component.

**Cause:** The `alpha` component isn't installed and the prompt can't be answered
in non-interactive shells.

**Resolution:** We don't need `gcloud alpha` for anything related to our OAuth setup.
The IAP API is irrelevant to standard web OAuth clients. Verify everything visually
in the GCP Console UI or via the REST API with an access token.

---

### 7. GCP Console shows old path vs new path

As of late 2025, the GCP Console reorganised auth settings:

| Old path                               | New path                                   |
| -------------------------------------- | ------------------------------------------ |
| APIs & Services → Credentials          | Google Auth Platform → Clients             |
| APIs & Services → OAuth consent screen | Google Auth Platform → Branding / Audience |

Both paths may exist simultaneously during the transition period. The new
`console.cloud.google.com/auth/clients?project=familiarise` URL is canonical.

---

## Quick Reference

### Current credentials (web app)

```
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
```

### Update Netlify env vars

```bash
netlify env:set GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID"
netlify env:set GOOGLE_CLIENT_SECRET "$GOOGLE_CLIENT_SECRET"
```

### Verify credentials belong to the right project

```bash
CLIENT_ID="$GOOGLE_CLIENT_ID"
echo "Prefix: $(echo $CLIENT_ID | cut -d'-' -f1)"
# Must print: 384845845365
```

### Verify People API is enabled

```bash
export PATH="$PATH:~/google-cloud-sdk/bin"
gcloud config set project familiarise
gcloud services list --enabled --filter="name:people.googleapis.com"
```

### GCP Console direct links

| Resource                           | URL                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| OAuth Clients list                 | `https://console.cloud.google.com/auth/clients?project=familiarise`                           |
| `familiarise-web-client` edit page | `https://console.cloud.google.com/auth/clients/<google-client-id-prefix>?project=familiarise` |
| Enabled APIs                       | `https://console.cloud.google.com/apis/dashboard?project=familiarise`                         |
| Project settings                   | `https://console.cloud.google.com/iam-admin/settings?project=familiarise`                     |
