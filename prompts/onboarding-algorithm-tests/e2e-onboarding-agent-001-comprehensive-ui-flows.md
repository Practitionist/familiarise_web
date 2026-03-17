# E2E Onboarding UI Test — Comprehensive Multi-Role Flow Testing

## Role & Mission

You are a **senior QA engineer** testing the onboarding multi-step form of a production-grade expert services marketplace (Familiarise). Your job is to exhaustively test every role's onboarding journey — **Consultee**, **Consultant**, and **Staff** — through the multi-step form, covering happy paths, validation failures, edge cases, back-navigation state preservation, role switching, modal CRUD, and database verification.

You have access to two MCP tools:

1. **Supabase MCP** — for seeding test users, verifying database state, and cleanup via `execute_sql`
2. **Chrome DevTools MCP** — for all UI interactions (click, fill, type_text, press_key, take_screenshot, wait_for, take_snapshot, etc.)

**Supabase Project ID: `pzmbxqdgibfkhjwzeprf`**

---

## CRITICAL RULES

1. **FIX BUGS IMMEDIATELY.** If you discover ANY bug during testing — broken UI, wrong API response, incorrect DB state, validation not showing, data not persisting — **STOP testing, fix the bug in the source code, verify the fix, and retest that phase from the beginning.** Do NOT accumulate a bug list. Fix. Retest. Move on.

2. **Verify DB state after every submission.** After each successful onboarding submission, use `execute_sql` to query the database and verify all expected records exist with correct values. Do not trust the UI alone.

3. **Take screenshots liberally.** Use `take_screenshot` at every step transition, after every validation error, after every modal interaction, and after every notable state change. Name them descriptively in your conversation output.

4. **Use `take_snapshot` before interacting** with any page to understand the current DOM state and find correct selectors.

5. **NEVER use `evaluate_script`.** All DOM interactions must go through the Chrome DevTools MCP action tools: `click`, `fill`, `type_text`, `press_key`, `wait_for`, `hover`, `select_page`, `navigate_page`.

6. **Use `wait_for`** after every click that triggers navigation, modal open/close, dropdown open, or form submission. Wait for specific text or selectors to appear.

7. **For Radix Select dropdowns:** Click the trigger element, use `wait_for` for the content popover to appear, then click the desired option item.

8. **For Radix Checkboxes:** Click the checkbox element directly by its `id` or a nearby label.

9. **Clean up after EVERY test phase** — delete the test user and ALL related data (profiles, work experiences, education, certifications, achievements, sessions, accounts) via cascading SQL deletes.

10. **The app runs at** `http://localhost:3000`. Assume the dev server is already running.

---

## Schema Reference

### Table Mappings (Prisma → Postgres)

| Prisma Model | Postgres Table | ID Type |
|---|---|---|
| `User` | `users` | `cuid()` (string) |
| `Account` | `accounts` | `cuid()` |
| `Session` | `sessions` | `cuid()` |
| `ConsultantProfile` | `"ConsultantProfile"` | `uuid()` |
| `ConsulteeProfile` | `"ConsulteeProfile"` | `uuid()` |
| `StaffProfile` | `"StaffProfile"` | `uuid()` |
| `WorkExperience` | `"WorkExperience"` | `uuid()` |
| `Education` | `"Education"` | `uuid()` |
| `Certification` | `"Certification"` | `uuid()` |
| `Achievement` | `"Achievement"` | `uuid()` |
| `Domain` | `"Domain"` | string |
| `SubDomain` | `"SubDomain"` | string |
| `Tag` | `"Tag"` | string |
| `ConsultantProfileVerification` | `"ConsultantProfileVerification"` | `uuid()` |
| `ProfileVerificationDocument` | `"ProfileVerificationDocument"` | `uuid()` |

### Key Fields

- `users.onboardingCompleted` — `Boolean`, default `false`
- `users.role` — enum: `CONSULTANT`, `CONSULTEE`, `STAFF`, `ADMIN`
- `users.bio` — `VARCHAR(160)`, max 160 chars
- `ConsultantProfile.scheduleType` — enum: `WEEKLY`, `CUSTOM`
- `ConsultantProfile.headline` — `VARCHAR(120)`, max 120 chars
- `ConsulteeProfile.careerStage` — enum: `STUDENT`, `EARLY_CAREER`, `MID_CAREER`, `SENIOR`, `EXECUTIVE`
- `Achievement.achievementType` — enum: `AWARD`, `PUBLICATION`, `PROJECT`, `TALK`, `OPEN_SOURCE`, `OTHER`

### BetterAuth Session Setup

To simulate a logged-in user, you need entries in `users`, `accounts`, and `sessions`. The session `token` becomes the auth cookie. Use this pre-hashed bcrypt password for all test users:

```
Password plaintext: TestPassword123!
Bcrypt hash: $2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012
```

**Important:** After creating the session in SQL, you need to set the `better-auth.session_token` cookie in the browser. Use `navigate_page` to go to `http://localhost:3000` first, then use the Chrome DevTools MCP to set the cookie before navigating to the onboarding page. If cookie-setting is not available via MCP, navigate directly to `http://localhost:3000/form/onboarding` and check if BetterAuth picks up the session from the DB. If authentication is an issue, try logging in via the app's sign-in UI at `http://localhost:3000/auth/sign-in` using the test email and password.

---

## PHASE 0: ENVIRONMENT SETUP

### Step 0.1: Discover Existing Reference Data

Before creating test users, query for domains/subdomains/tags that already exist in the database:

```sql
SELECT id, name FROM "Domain" ORDER BY name LIMIT 10;
```

```sql
SELECT id, name, "domainId" FROM "SubDomain" ORDER BY name LIMIT 20;
```

```sql
SELECT id, name, "domainId" FROM "Tag" ORDER BY name LIMIT 20;
```

**Store these IDs** — you'll need them when verifying consultant profile domain selections.

If no domains exist, create test data:

```sql
INSERT INTO "Domain" (id, name, "createdAt", "updatedAt")
VALUES ('test-domain-onb-001', 'Technology & Engineering', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "SubDomain" (id, name, "domainId", "createdAt", "updatedAt")
VALUES
  ('test-sub-onb-001', 'Software Engineering', 'test-domain-onb-001', NOW(), NOW()),
  ('test-sub-onb-002', 'Data Science', 'test-domain-onb-001', NOW(), NOW()),
  ('test-sub-onb-003', 'DevOps & Infrastructure', 'test-domain-onb-001', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Tag" (id, name, "domainId", "createdAt", "updatedAt")
VALUES
  ('test-tag-onb-001', 'Python', 'test-domain-onb-001', NOW(), NOW()),
  ('test-tag-onb-002', 'System Design', 'test-domain-onb-001', NOW(), NOW()),
  ('test-tag-onb-003', 'Kubernetes', 'test-domain-onb-001', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
```

### Step 0.2: Test User Creation Template

Use this template for every test phase. Change the ID suffix per phase.

```sql
-- Create test user
INSERT INTO users (
  id, name, email, "emailVerified", role,
  "onboardingCompleted", timezone,
  "createdAt", "updatedAt"
) VALUES (
  'test-onb-phase<N>',
  'Phase<N> TestUser',
  'testonb-phase<N>@test.com',
  true,
  '<ROLE>',       -- CONSULTEE, CONSULTANT, or STAFF
  false,
  'America/New_York',
  NOW(), NOW()
);

-- Create BetterAuth account (credential provider)
INSERT INTO accounts (
  id, "userId", "accountId", "providerId",
  password,
  "createdAt", "updatedAt"
) VALUES (
  'test-acct-phase<N>',
  'test-onb-phase<N>',
  'test-onb-phase<N>',
  'credential',
  '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012',
  NOW(), NOW()
);

-- Create active session
INSERT INTO sessions (
  id, token, "userId", "expiresAt",
  "ipAddress", "userAgent",
  "createdAt", "updatedAt"
) VALUES (
  'test-sess-phase<N>',
  'test-token-phase<N>',
  'test-onb-phase<N>',
  NOW() + INTERVAL '24 hours',
  '127.0.0.1', 'OnboardingTestAgent/1.0',
  NOW(), NOW()
);
```

### Step 0.3: Cleanup Template

Use this after every test phase:

```sql
-- Cascading delete: user deletion cascades to profiles, experiences, sessions, accounts
DELETE FROM users WHERE id = 'test-onb-phase<N>';
```

Verify cleanup:
```sql
SELECT COUNT(*) FROM users WHERE id = 'test-onb-phase<N>';
-- Should return 0
```

---

## PHASE 1: Consultee — Happy Path (Full Valid Input)

**Goal:** Complete the entire 5-step consultee onboarding with all fields filled.

### Setup
Create test user with `role = 'CONSULTEE'` using Phase 0 template (use `phase1` as suffix).

### Step 1.1: Navigate & Authenticate

1. Navigate to `http://localhost:3000/auth/sign-in`
2. Take snapshot to find the email/password form fields
3. Fill email `testonb-phase1@test.com`, password `TestPassword123!`
4. Click the sign-in button
5. Wait for redirect — you should land on `/form/onboarding` since `onboardingCompleted` is false
6. Take screenshot: **"phase1-step1-initial"**
7. Verify you see "Step 1 of 5" in the header
8. Verify the stepper shows 5 steps with labels: "Personal Info", "Profile", "Preferences", "Agreement", "Review"

### Step 1.2: Personal Info (Step 1)

1. Take snapshot to find form fields
2. Verify the email field is pre-filled and disabled
3. Fill:
   - Name: "Alice TestConsultee"
   - Phone: "+15550101"
   - Select gender "Female" from the gender dropdown
   - City: "San Francisco"
   - Country: "United States"
   - Bio: "Software engineer exploring mentorship opportunities"
   - LinkedIn: "https://linkedin.com/in/alicetest"
4. Verify the "Consultee" role card is selected (should be default)
5. Take screenshot: **"phase1-step1-filled"**
6. Click "Continue"
7. Wait for step 2 to appear
8. Verify header shows "Step 2 of 5"

### Step 1.3: Consultee Profile (Step 2)

1. Take snapshot
2. Fill:
   - Occupation: "Software Engineer"
   - Company: "TestCorp Inc"
   - Industry: "Technology"
   - Select Career Stage: "Mid Career (3-10 years)"
   - About Me: "I'm a mid-career software engineer looking for guidance on transitioning into engineering management. I have 6 years of experience building distributed systems."
3. Take screenshot: **"phase1-step2-filled"**
4. Click "Continue"
5. Wait for step 3

### Step 1.4: Preferences (Step 3)

1. Take snapshot
2. Verify "Preferred Language" field exists (may be pre-filled with "English")
3. Fill preferred language: "English"
4. Take screenshot: **"phase1-step3-preferences"**
5. Click "Continue"
6. Wait for step 4

### Step 1.5: Agreement (Step 4)

1. Take snapshot
2. Verify the "Complete Registration" button is **disabled**
3. Take screenshot: **"phase1-step4-button-disabled"**
4. Click the terms checkbox (find by id "terms" or nearby label text)
5. Click the privacy checkbox (find by id "privacy" or nearby label text)
6. Verify the "Complete Registration" button is now **enabled**
7. Take screenshot: **"phase1-step4-both-checked"**
8. Click "Complete Registration"
9. Wait for a toast notification or navigation

### Step 1.6: Verify Result

1. Take screenshot: **"phase1-submission-result"**
2. Check if redirected to a dashboard URL (should be `/dashboard/consultee/...`)

### Step 1.7: Database Verification

```sql
SELECT u.name, u.email, u.role, u."onboardingCompleted", u.phone, u.city, u.country, u.bio, u.gender,
       cp.id as "consulteeProfileId", cp.occupation, cp."aboutMe", cp."careerStage", cp."currentCompany", cp.industry
FROM users u
LEFT JOIN "ConsulteeProfile" cp ON cp."userId" = u.id
WHERE u.id = 'test-onb-phase1';
```

**Verify:**
- `onboardingCompleted` = `true`
- `role` = `CONSULTEE`
- `name` = `Alice TestConsultee`
- `consulteeProfileId` is NOT null
- `occupation` = `Software Engineer`
- `careerStage` = `MID_CAREER`
- `currentCompany` = `TestCorp Inc`

Also verify no orphaned profiles:
```sql
SELECT COUNT(*) FROM "ConsultantProfile" WHERE "userId" = 'test-onb-phase1';
SELECT COUNT(*) FROM "StaffProfile" WHERE "userId" = 'test-onb-phase1';
-- Both should be 0
```

### Step 1.8: Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase1';
```

---

## PHASE 2: Consultee — Validation Failures & Edge Cases

**Goal:** Test all validation paths, empty submissions, bio character limit, and field error display.

### Setup
Create test user with `role = 'CONSULTEE'`, suffix `phase2`.

### Step 2.1: Empty Name Submission

1. Sign in and navigate to onboarding
2. Clear the name field entirely (it may be pre-filled from the session)
3. Click "Continue"
4. Take screenshot: **"phase2-empty-name-error"**
5. Verify a validation error appears for the name field (text like "Name is required")

### Step 2.2: Bio Over 160 Characters

1. Fill name: "Bob Test"
2. Fill bio with exactly 170 characters: "This is a test bio that intentionally exceeds the maximum character limit of one hundred and sixty characters to verify the validation and counter display correctly working."
3. Take screenshot: **"phase2-bio-overlimit"**
4. Verify the character counter shows red (e.g., "170/160")
5. Clear bio to 100 chars: "This is a valid bio that fits within the character limit for testing purposes."
6. Verify counter is no longer red
7. Select Consultee role, click Continue

### Step 2.3: Missing Required Profile Fields

1. On step 2 (Consultee Profile), leave occupation and "About Me" empty
2. Click "Continue"
3. Take screenshot: **"phase2-missing-required-fields"**
4. Verify error messages appear for occupation ("Occupation is required") and aboutMe ("About me is required")
5. Fill both fields, continue through to step 3

### Step 2.4: Back Navigation Preserves Data

1. From step 3 (Preferences), click "Back"
2. Take screenshot: **"phase2-back-to-step2"**
3. Verify: occupation and "About Me" fields are still filled with previously entered data
4. Click "Back" again (to step 1)
5. Take screenshot: **"phase2-back-to-step1"**
6. Verify: name "Bob Test" is still present in the name field
7. Click "Continue" twice to return to step 3
8. Continue through steps 4 and submit

### Step 2.5: Agreement Button Guard

1. On step 4, verify "Complete Registration" is disabled
2. Check ONLY the terms checkbox (not privacy)
3. Verify button is STILL disabled
4. Take screenshot: **"phase2-only-terms-checked"**
5. Uncheck terms, check only privacy
6. Verify button is STILL disabled
7. Check both
8. Verify button is now enabled
9. Submit

### Step 2.6: Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase2';
```

---

## PHASE 3: Consultant — Happy Path (Full Input + Professional Background)

**Goal:** Complete all 5 consultant steps including professional profile with domain/tags, work experience, education, certification, and achievement modals.

### Setup
Create test user with `role = 'CONSULTANT'`, suffix `phase3`.

### Step 3.1: Sign In & Personal Info

1. Sign in and navigate to onboarding
2. Fill:
   - Name: "Charlie TestConsultant"
   - Phone: "+15550202"
   - Gender: "Male"
   - City: "New York"
   - Country: "United States"
   - Bio: "Expert engineer and mentor"
3. Click the **"Consultant"** role card
4. Verify the role card shows as selected (highlighted border/background)
5. Take screenshot: **"phase3-step1-consultant-selected"**
6. Click "Continue"
7. Verify step 2 shows "Professional Profile" in the stepper

### Step 3.2: Professional Profile — Expertise Tab

1. Take snapshot to understand the tab layout
2. Verify two tabs exist: "Expertise & Domain" and "Experience & Credentials"
3. Verify the "Experience & Credentials" tab is disabled (expertise must be filled first)
4. Fill:
   - Description: "Experienced software engineer with 12+ years building distributed systems at scale. I specialize in system design, microservices architecture, and mentoring senior engineers transitioning to staff-level roles."
   - Headline: "Staff Engineer | System Design"
   - Experience: 12
5. Select a domain from the dropdown:
   - Click the domain select trigger
   - Wait for the dropdown content to appear
   - Click the first available domain
   - Take screenshot: **"phase3-step2-domain-selected"**
6. Wait for subdomains and tags to load
7. Check 2 subdomain checkboxes (click them)
8. Check 2 tag checkboxes (click them)
9. Verify "Weekly Schedule" button is selected by default in Schedule Preference
10. Take screenshot: **"phase3-step2-expertise-filled"**
11. Click "Continue" (this advances to the Experience tab, NOT to step 3)

### Step 3.3: Professional Profile — Experience Tab

Verify the "Experience & Credentials" tab is now active. You should see sections for Work Experience, Education, Certifications, and Achievements.

#### Work Experience — Add Two Entries

1. Click "Add Work Experience" button
2. Wait for the modal dialog to appear
3. Take snapshot to find modal fields
4. Fill:
   - Job Title: "Staff Engineer"
   - Company: "Google"
   - Wait a moment — verify logo auto-detection text appears (e.g., "Logo detected automatically")
   - Location: "Mountain View, CA"
   - Start Date: "2019-01-15"
   - Check "I currently work here" checkbox
   - Description: "Leading distributed systems team, mentoring 5 engineers"
5. Click "Add" button in the modal footer
6. Wait for modal to close
7. Take screenshot: **"phase3-work-exp-google-added"**
8. Verify a card appears showing "Staff Engineer" at "Google" with the company logo

9. Click "Add Work Experience" again
10. Fill:
    - Job Title: "Senior Software Engineer"
    - Company: "Amazon"
    - Location: "Seattle, WA"
    - Start Date: "2015-06-01"
    - End Date: "2018-12-31"
    - Description: "Built high-throughput order processing pipeline"
11. Click "Add"
12. Take screenshot: **"phase3-work-exp-both-added"**
13. Verify TWO work experience cards are visible

#### Work Experience — Edit

1. Hover over the Google work experience card to reveal action buttons
2. Click the edit (pencil) icon
3. Wait for the edit modal to appear
4. Change title from "Staff Engineer" to "Principal Engineer"
5. Click "Save Changes"
6. Wait for modal to close
7. Verify the card now shows "Principal Engineer" instead of "Staff Engineer"
8. Take screenshot: **"phase3-work-exp-edited"**

#### Education — Add

1. Scroll down to the Education section
2. Click "Add Education"
3. Wait for modal
4. Fill:
   - School/University: "Massachusetts Institute of Technology"
   - Degree: "Master of Science"
   - Field of Study: "Computer Science"
   - Start Year: select "2013" from dropdown
   - End Year: select "2015" from dropdown
   - Grade: "4.0/4.0"
5. Click "Add"
6. Take screenshot: **"phase3-education-added"**

#### Certification — Add

1. Scroll to Certifications section
2. Click "Add Certification"
3. Wait for modal
4. Fill:
   - Certification Name: "AWS Solutions Architect Professional"
   - Issuing Organization: "Amazon Web Services"
   - Issue Date: "2023-06-15"
   - Leave Expiry Date empty
   - Credential ID: "AWS-SAP-2023-12345"
5. Click "Add"
6. Take screenshot: **"phase3-certification-added"**
7. Verify the card shows "AWS Solutions Architect Professional" by "Amazon Web Services" WITHOUT "Expires" text

#### Achievement — Add

1. Scroll to Achievements section
2. Click "Add Achievement"
3. Wait for modal
4. Fill:
   - Title: "Speaker at KubeCon 2024"
   - Select Type: "Talk / Conference"
   - Description: "Presented on service mesh patterns at scale"
5. Click "Add"
6. Take screenshot: **"phase3-achievement-added"**
7. Verify type label shows "Talk / Conference"

#### Advance to Step 3

1. Click the "Continue" button at the bottom of the Experience tab
2. Wait for step 3 (Availability) to appear
3. Verify stepper shows step 3 highlighted

### Step 3.4: Availability (Step 3)

1. Take screenshot: **"phase3-step3-availability"**
2. The schedule form should be visible (Weekly by default from step 2 selection)
3. Click "Continue" to advance to step 4

### Step 3.5: Agreement & Verification (Step 4)

1. Take snapshot
2. Verify the page has two sections: Verification (LinkedIn, documents) and Terms
3. Fill LinkedIn URL: "https://linkedin.com/in/charlietest"
4. Take screenshot: **"phase3-step4-linkedin-filled"**
5. Check both agreement checkboxes (terms + privacy)
6. Click "Submit for Review"
7. **Expect an error:** Document upload is required, and no documents have been uploaded
8. Take screenshot: **"phase3-step4-document-required-error"**
9. Verify an error message appears about uploading documents

**Note:** Actual file upload requires a real file upload API interaction, which may not be possible via MCP tools. Record this as a known limitation and note what error message was shown.

### Step 3.6: Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase3';
```

---

## PHASE 4: Consultant — Minimal Input (Skip All Optional Fields)

**Goal:** Verify onboarding works with only the bare minimum required fields filled.

### Setup
Create test user with `role = 'CONSULTANT'`, suffix `phase4`.

### Steps

1. Sign in, navigate to onboarding
2. **Step 1:** Fill ONLY name (required). Skip phone, gender, city, country, bio, LinkedIn. Select Consultant role. Click Continue.
3. **Step 2 — Expertise Tab:**
   - Fill description (required): "Consultant with broad experience."
   - Set experience to 0
   - Select a domain (required)
   - Skip headline, subdomains, tags
   - Click Continue (to Experience tab)
4. **Step 2 — Experience Tab:**
   - Do NOT add any work experience, education, certifications, or achievements
   - All four sections should show their empty-state messages
   - Take screenshot: **"phase4-empty-experience-tab"**
   - Click Continue
5. **Step 3:** Continue without modifying availability
6. **Step 4:** Take screenshot: **"phase4-verification-step-minimal"**
   - Verify the page loads correctly even with minimal data
   - The review section should show "Not provided" for missing fields
7. Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase4';
```

---

## PHASE 5: Modal CRUD Stress Test

**Goal:** Exhaustively test add, edit, and delete for all 4 professional background entity types.

### Setup
Create test user with `role = 'CONSULTANT'`, suffix `phase5`. Sign in and navigate to step 2, Experience tab.

### Step 5.1: Work Experience — Bulk Add & Delete

1. Add 3 work experiences:
   - "Engineer" at "Company A", start 2020-01-01, current
   - "Intern" at "Company B", start 2019-06-01, end 2019-12-31
   - "Lead" at "Company C", start 2021-01-01, current
2. Verify all 3 cards appear
3. Take screenshot: **"phase5-three-work-exps"**
4. Delete the MIDDLE one ("Intern" at "Company B"):
   - Hover over the Company B card
   - Click the delete (trash) icon
5. Verify only 2 cards remain: "Company A" and "Company C"
6. Take screenshot: **"phase5-after-delete-middle"**

### Step 5.2: Education — Add, Edit, Delete

1. Add 2 education entries:
   - "Stanford University", "Bachelor of Science", "Computer Science", 2010-2014
   - "UC Berkeley", "Master of Engineering", "EECS", 2014-2016
2. Edit the first one:
   - Click edit icon on Stanford entry
   - Change institution to "Stanford Engineering"
   - Click "Save Changes"
3. Verify the card updates to "Stanford Engineering"
4. Delete the second one (UC Berkeley)
5. Verify only "Stanford Engineering" remains
6. Take screenshot: **"phase5-education-edit-delete"**

### Step 5.3: Certification — Date Edge Cases

1. Add certification WITH expiry date:
   - Name: "PMP", Org: "PMI", Issue: "2022-01-01", Expiry: "2025-01-01"
   - After adding, verify card shows "Expires Jan 2025"
2. Add certification WITHOUT expiry date:
   - Name: "CKA", Org: "CNCF", Issue: "2023-06-01", leave expiry empty
   - After adding, verify card does NOT show "Expires" text
3. Take screenshot: **"phase5-certifications-with-without-expiry"**

### Step 5.4: Achievement — All Types

Add one achievement of each type and verify correct type labels:

1. Type "Award": Title "Best Paper Award 2023"
2. Type "Publication": Title "Distributed Systems at Scale (O'Reilly)"
3. Type "Project": Title "Open-source Load Balancer"
4. Type "Talk / Conference": Title "Speaker at GopherCon"
5. Type "Open Source": Title "Maintainer of kubectl-debug"
6. Type "Other": Title "Patent: US-2023-12345"

Take screenshot: **"phase5-all-achievement-types"**

Verify each card shows the correct label text ("Award", "Publication", "Project", "Talk / Conference", "Open Source", "Other").

Delete all but one ("Speaker at GopherCon"). Verify 5 are removed and only 1 remains.

Take screenshot: **"phase5-achievements-after-cleanup"**

### Step 5.5: Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase5';
```

---

## PHASE 6: Role Switching Mid-Flow

**Goal:** Verify that switching roles during onboarding changes the step flow and labels.

### Setup
Create test user with `role = 'CONSULTEE'`, suffix `phase6`.

### Steps

1. Sign in, navigate to onboarding
2. Verify stepper labels are: "Personal Info", "Profile", "Preferences", "Agreement", "Review"
3. Fill step 1 with name "Switcher Test", select Consultee role, click Continue
4. Fill step 2 consultee profile (occupation, aboutMe), click Continue
5. You should be on step 3 (Preferences)
6. Take screenshot: **"phase6-at-step3-consultee"**
7. Click "Back" to return to step 2
8. Click "Back" again to return to step 1
9. Take screenshot: **"phase6-back-at-step1"**
10. Click the **"Consultant"** role card
11. Take screenshot: **"phase6-switched-to-consultant"**
12. Click "Continue"
13. **Verify:** Step 2 should now show the CONSULTANT professional profile form (with tabs "Expertise & Domain" / "Experience & Credentials"), NOT the consultee profile form
14. Verify the stepper labels changed to: "Personal Info", "Professional Profile", "Availability", "Agreement & Verification", "Review"
15. Take screenshot: **"phase6-consultant-step2-after-switch"**

### Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase6';
```

---

## PHASE 7: Stepper & Progress UI Verification

**Goal:** Verify the stepper progress indicator updates correctly at each step.

### Setup
Create test user with `role = 'CONSULTEE'`, suffix `phase7`.

### Steps

1. Sign in, navigate to onboarding
2. **At step 1:**
   - Verify header shows "Step 1 of 5"
   - Take screenshot: **"phase7-stepper-step1"**
   - Verify step 1 circle is highlighted (should have a ring effect)
   - Verify steps 2-5 circles show numbers 2, 3, 4, 5 (not checkmarks)

3. Fill name, select Consultee, click Continue

4. **At step 2:**
   - Verify header shows "Step 2 of 5"
   - Take screenshot: **"phase7-stepper-step2"**
   - Verify step 1 circle now shows a **checkmark** (completed)
   - Verify step 2 circle is highlighted with ring effect
   - Verify steps 3-5 are still dimmed

5. Fill required fields, advance through steps 3, 4 (check both checkboxes)

6. **At step 5 (Review):**
   - Verify header shows "Step 5 of 5"
   - Take screenshot: **"phase7-stepper-step5"**
   - Verify steps 1-4 all show checkmarks
   - Verify step 5 is highlighted

7. Submit and verify success

### Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase7';
```

---

## PHASE 8: Consultee — Database State Deep Verification

**Goal:** Submit a complete consultee onboarding and verify every field persists correctly in the database.

### Setup
Create test user with `role = 'CONSULTEE'`, suffix `phase8`.

### Steps

1. Sign in and complete the full consultee onboarding with ALL fields:
   - Name: "DatabaseVerify User"
   - Phone: "+15559999"
   - Gender: FEMALE
   - City: "Chicago"
   - Country: "United States"
   - Bio: "Testing database persistence"
   - Occupation: "Data Scientist"
   - Company: "DataCorp"
   - Industry: "Analytics"
   - Career Stage: "Senior (10+ years)"
   - About Me: "Senior data scientist with focus on ML pipelines and real-time analytics systems."
   - Preferred Language: "English"
   - Accept both terms

2. After successful submission, run verification queries:

```sql
-- Verify user record
SELECT
  id, name, email, role, "onboardingCompleted",
  phone, gender, city, country, bio,
  "consulteeProfileId"
FROM users
WHERE id = 'test-onb-phase8';
```

**Assert:**
- `onboardingCompleted` = `true`
- `role` = `CONSULTEE`
- `name` = `DatabaseVerify User`
- `phone` = `+15559999`
- `gender` = `FEMALE`
- `city` = `Chicago`
- `country` = `United States`
- `bio` = `Testing database persistence`
- `consulteeProfileId` is NOT null

```sql
-- Verify consultee profile
SELECT
  id, occupation, "aboutMe", "careerStage",
  "currentCompany", industry, "preferredLanguage"
FROM "ConsulteeProfile"
WHERE "userId" = 'test-onb-phase8';
```

**Assert:**
- `occupation` = `Data Scientist`
- `aboutMe` starts with `Senior data scientist`
- `careerStage` = `SENIOR`
- `currentCompany` = `DataCorp`
- `industry` = `Analytics`

```sql
-- Verify NO orphaned profiles for other roles
SELECT COUNT(*) as consultant_count FROM "ConsultantProfile" WHERE "userId" = 'test-onb-phase8';
SELECT COUNT(*) as staff_count FROM "StaffProfile" WHERE "userId" = 'test-onb-phase8';
SELECT COUNT(*) as admin_count FROM "AdminProfile" WHERE "userId" = 'test-onb-phase8';
-- All should be 0
```

### Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase8';
```

---

## PHASE 9: Consultant — Review Step Data Display

**Goal:** Verify the review step correctly renders all submitted data including professional background.

### Setup
Create test user with `role = 'CONSULTANT'`, suffix `phase9`.

### Steps

1. Sign in, complete consultant steps 1-2 with full data:
   - Step 1: Name "ReviewTest Consultant", city "Austin", country "US"
   - Step 2 Expertise: Description, headline, experience=8, domain, 2 subdomains, 2 tags
   - Step 2 Experience: Add 1 work experience ("Google", "Engineer"), 1 education ("MIT", "BS CS"), 1 certification ("AWS SAP")

2. Advance to step 3 (Availability), continue

3. On step 4 (Agreement & Verification), navigate back to review the data, or if the consultant flow goes Agreement→Review, proceed to step 5

4. **On the Review step:**
   - Take snapshot to understand what's rendered
   - Take screenshot: **"phase9-review-step-full"**
   - Verify the following sections are rendered:
     - **Personal Information:** Name, Email, Phone, City, Country
     - **Professional Details:** Description, Headline, Experience (with "years")
     - **Domain & Tags:** Domain name, sub-domains as chips/badges, tags as chips/badges
     - **Schedule:** Schedule type shown
     - **Professional Background:** Work Experience cards, Education cards, Certification cards
   - Verify fields show actual values, not "Not provided" (since we filled everything)
   - Take screenshot of each section as you scroll: **"phase9-review-personal"**, **"phase9-review-professional"**, **"phase9-review-background"**

### Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase9';
```

---

## PHASE 10: Staff Onboarding — Happy Path (Invite-Only Bypass)

**Goal:** Test the Staff onboarding flow. Staff is normally invite-only, but the form UI shows it as greyed out. However, we can test what happens when a user with `role = 'STAFF'` already set in the DB accesses onboarding.

**Important:** The backend rejects STAFF role from public onboarding. This phase tests the **UI-level behavior** — what the user sees if they try to select Staff, and what happens if a staff user hits the onboarding page.

### Setup
Create test user with `role = 'STAFF'`, suffix `phase10`.

### Steps

1. Sign in with the staff user
2. Navigate to onboarding
3. Take screenshot: **"phase10-staff-onboarding-page"**
4. On step 1:
   - Verify the "Staff" role card is **greyed out / disabled** with text "Invite only"
   - Take screenshot: **"phase10-staff-role-disabled"**
   - Try clicking the Staff card — verify it does NOT select
   - Select "Consultee" instead (since Staff is disabled in UI)
5. Fill required fields, proceed through the consultee flow to submission
6. Verify the submission completes (backend should accept CONSULTEE role regardless of original DB role)

### Alternative Test (if staff role card can somehow be selected):

If you manage to select Staff and proceed:
- Step 2 should be "Role Details" (department + position selection)
- Step 3 should be "Responsibilities" (checkboxes for responsibilities and permissions)
- Step 4 should be "Agreement"
- Step 5 should be "Review"

Take screenshots at each staff-specific step.

### Cleanup

```sql
DELETE FROM users WHERE id = 'test-onb-phase10';
```

---

## PHASE 11: Edge Cases & Boundary Testing

**Goal:** Test obscure edge cases.

### Setup
Create test user with `role = 'CONSULTEE'`, suffix `phase11`.

### Step 11.1: Sign-Out Button

1. Navigate to onboarding
2. Find and click the "Sign out" button in the header
3. Verify you are redirected to the home page or sign-in page
4. Take screenshot: **"phase11-sign-out-redirect"**

### Step 11.2: Double-Click Submit Protection

1. Sign in with a fresh test user (`phase11b`)
2. Navigate through all consultee steps to the agreement step
3. Check both checkboxes
4. Click "Complete Registration"
5. Immediately try to click it again (rapid double-click)
6. Verify only ONE submission occurs (button should disable after first click, show loading spinner)
7. Take screenshot: **"phase11-double-click-protection"**

### Step 11.3: Special Characters in Fields

1. Sign in with a fresh test user (`phase11c`)
2. Fill name with special characters: "O'Brien-López Müller"
3. Fill bio: "I'm a consultant & I love <coding>"
4. Fill city: "São Paulo"
5. Proceed through all steps and submit
6. Verify in DB that special characters are preserved:

```sql
SELECT name, bio, city FROM users WHERE id = 'test-onb-phase11c';
```

### Cleanup

```sql
DELETE FROM users WHERE id LIKE 'test-onb-phase11%';
```

---

## Final Cleanup

After all phases, ensure no test data remains:

```sql
-- Verify no test users remain
SELECT id, name FROM users WHERE id LIKE 'test-onb-%';
-- Should return 0 rows

-- Clean up test domains if created
DELETE FROM "Tag" WHERE id LIKE 'test-tag-onb-%';
DELETE FROM "SubDomain" WHERE id LIKE 'test-sub-onb-%';
DELETE FROM "Domain" WHERE id LIKE 'test-domain-onb-%';
```

---

## Success Criteria

| # | Criterion | Phase |
|---|-----------|-------|
| 1 | Consultee happy path submits and persists correctly in DB | 1, 8 |
| 2 | Validation errors appear for empty/invalid required fields | 2 |
| 3 | Bio character counter enforces 160-char limit visually | 2 |
| 4 | Back navigation preserves all form state across steps | 2 |
| 5 | Agreement checkboxes correctly gate the submit button | 2 |
| 6 | Consultant professional profile form loads with domain/subdomain/tags | 3 |
| 7 | Work experience modal: add, edit (title change), logo auto-detection | 3, 5 |
| 8 | Education modal: add, edit, delete | 5 |
| 9 | Certification modal: with/without expiry date | 5 |
| 10 | Achievement modal: all 6 types render correct labels | 5 |
| 11 | Delete middle item from a list preserves others | 5 |
| 12 | Consultant minimal input (skip optional) doesn't crash | 4 |
| 13 | Role switching mid-flow changes step labels and form type | 6 |
| 14 | Stepper circles, checkmarks, and step counter update correctly | 7 |
| 15 | All submitted fields persist with correct values in DB | 8 |
| 16 | No orphaned profiles created for wrong roles | 1, 8 |
| 17 | Review step displays all filled data | 9 |
| 18 | Staff role card is disabled in UI | 10 |
| 19 | Sign-out button works | 11 |
| 20 | Double-click submit protection | 11 |
| 21 | Special characters preserved in DB | 11 |
| 22 | All test data cleaned up | All |
