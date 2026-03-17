# Dynamic Tags Strategy for Consultant Profiles

## Problem

Tags/skills for consultant profiles are currently seeded from a hardcoded list in `prisma/seedFiles/1a-create-users.ts`. This is limiting because:

- Tags can't grow beyond the seed list
- New domains require code changes
- Consultants with niche skills can't represent them

## APIs Evaluated (and Why They Don't Work)

### ESCO API (EU Commission) — Rejected

- **13,485 skills**, free, no auth required
- **Problem**: It's a classification system, not a suggestion engine. Searching "Technology" returns "embryology", "operate flexographic printing machine", and "psychology" because those skill descriptions mention "technology" somewhere
- The search is keyword-in-description, not domain-categorized — results are irrelevant for curated tag suggestions
- API: `https://ec.europa.eu/esco/api/search?text={query}&type=skill&language=en`

### Lightcast Open Skills — Too Expensive

- 33,000+ properly categorized skills with domain mappings
- Requires paid partnership/auth — not viable for pre-launch budget

### Tanova AI — Too Narrow

- Only 105 tech skills (CC BY 4.0, free)
- Doesn't cover business, health, education, creative arts, personal development

### O*NET — Wrong Granularity

- US Department of Labor, 17,000+ occupations
- Skills are mapped to occupations, not domains/industries
- Good for job matching, not for consultant profile tags

## Chosen Strategy: Curated Seeds + Custom Free-Text Tags

### How It Works

1. **Curated seed tags** — High-quality, hand-picked tags per domain (already in place via seed file). These serve as the "starter" tags that most consultants will recognize
2. **Custom tag input** — Consultants can type and add their own tags. New tags are created in the DB on the fly (upserted by `name + domainId`)
3. **Organic growth** — As consultants add custom tags, the tag pool grows. Popular custom tags naturally become "standard" for that domain

### Why This Is Better Than an API

- **Relevance**: Curated tags are 100% relevant to the domain (vs. ESCO's keyword-matching noise)
- **Platform-specific**: Tags reflect what *our* consultants actually offer, not a generic EU labor classification
- **Indian market fit**: Tags like "UPSC Preparation", "CAT Coaching", "GST Compliance" can be added by consultants — no API would have these
- **Zero latency**: No external API calls, no dependency on third-party uptime
- **Cost**: Free forever

### Implementation

**Files changed:**
- `app/form/onboarding/components/ConsultantProfileForm.tsx` — Add free-text input for custom tags
- `app/api/user/content/tags/route.ts` — Extended with POST for custom tag upsert

**Frontend UX:**
1. Existing DB tags shown as checkboxes (unchanged)
2. Below the checkbox grid: text input with "Add custom skill" placeholder
3. On Enter/click: upsert tag via API, add to selection
4. Custom tags appear as removable pills above the checkbox grid

### Custom Tag Validation (Content Quality)

Custom tags pass through a shared `validateTagName()` function (`utils/contentValidation.ts`)
enforced at **both** the frontend (instant feedback) and the API (defense in depth):

1. **Length**: min 2, max 60 characters
2. **Character regex**: only `a-zA-Z0-9`, spaces, and common skill symbols (`. + # - & / @ ()`) — blocks emoji, unicode junk, special characters
3. **Gibberish detection**: reuses `isMeaningfulText()` — catches keyboard smashing, repeated characters, no-vowel strings
4. **Profanity filter**: reuses `isProfanityFree()` backed by `bad-words` library + custom blocklist

**What it doesn't catch**: semantically irrelevant but real words (e.g., "Farming" under Technology). This is acceptable for launch — founding consultants are vetted. Phase 2 option: admin moderation queue with a `verified` flag on custom tags.

### Seed Quality Improvement (Future)

The current seed tags in `1a-create-users.ts` could be expanded with better coverage. For the tech domain specifically, good sources for tag lists:
- Stack Overflow Developer Survey skill categories
- LinkedIn's skill endorsement categories (publicly visible on profiles)
- Job posting platforms (Naukri, LinkedIn Jobs) — common required skills

This is a curation task, not an API integration task.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-17 | Rejected ESCO API | Search returns irrelevant skills (keyword-in-description, not domain-categorized) |
| 2026-03-17 | Rejected Lightcast | Paid partnership required |
| 2026-03-17 | Chose curated seeds + custom input | Best relevance, zero cost, Indian market fit, no external dependency |
| 2026-03-17 | Added content validation layer | Profanity, gibberish, format checks on custom tags — shared between frontend and API |
| 2026-03-17 | Cleaned ESCO junk from DB | Deleted ~30 irrelevant tags upserted during ESCO testing, restored original 19 seed tags for Technology |
