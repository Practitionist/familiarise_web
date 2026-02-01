# User Schema Enhancement Plan

> **Version:** 1.0
> **Date:** December 6, 2025
> **Status:** Planning
> **Author:** Development Team

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Competitor Research](#competitor-research)
3. [Current State Analysis](#current-state-analysis)
4. [Proposed Changes](#proposed-changes)
5. [New Models](#new-models)
6. [Field Additions](#field-additions)
7. [Field Removals](#field-removals)
8. [New Enums](#new-enums)
9. [Admin Role System](#admin-role-system)
10. [UI/UX Simplification](#uiux-simplification)
11. [Implementation Phases](#implementation-phases)
12. [Migration Strategy](#migration-strategy)
13. [API Changes](#api-changes)
14. [Testing Strategy](#testing-strategy)
15. [Rollback Plan](#rollback-plan)

---

## Executive Summary

This document outlines a comprehensive plan to enhance the user architecture across all four user roles: **Consultant**, **Consultee**, **Staff**, and **Admin**. The goal is to:

1. Enrich user profiles with relevant biodata fields based on competitor analysis
2. Introduce nested models for work experience, certifications, and education
3. Create a missing AdminProfile model with role-based access control
4. Simplify the onboarding UI by removing complex theme-based styling
5. Update all related components: Zod schemas, API routes, server actions, and settings forms
6. Fix incomplete staff and admin dashboards
7. Improve error messaging throughout the application

---

## Competitor Research

### Platforms Analyzed

| Platform                                      | Focus                | Key Insights                                                               |
| --------------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| [Topmate.io](https://topmate.io/)             | 1:1 Mentorship       | Social links, testimonials, masked emails for privacy, smart reminders     |
| [Preplaced.in](https://www.preplaced.in/)     | Long-term Mentorship | Mentee capacity, placement tracking, mentor-mentee matching filters        |
| [GrowthMentor](https://www.growthmentor.com/) | Startup Mentorship   | Detailed profiles with tools/projects, 3000-char bio, specialties required |
| [UpGrad](https://www.upgrad.com/)             | EdTech               | Learner 360 platform, personalized mentor tracking, career coaching        |
| [Edureka](https://www.edureka.co/)            | Technical Training   | Industry experts with 10+ years experience, revenue sharing model          |
| [ProPeers.in](https://propeers.in/)           | Peer Mentorship      | (Limited data available)                                                   |

### Key Biodata Fields from Competitors

#### For Mentors/Consultants

- **Profile basics:** Headline/tagline, bio (up to 3000 chars), profile picture
- **Professional:** Work experience history, certifications, education
- **Social presence:** LinkedIn, Twitter, GitHub, portfolio website
- **Expertise:** Tools/technologies, specialties, projects worked on
- **Availability:** Languages spoken, session types, mentoring style
- **Trust signals:** Verification status, testimonials, ratings, placement count

#### For Mentees/Consultees

- **Career context:** Career stage, current company, industry
- **Goals:** Skills to develop, career goals, budget preferences
- **Professional:** LinkedIn profile, education background
- **Preferences:** Communication method, language, session frequency

### Best Practices Identified

From [Together Platform](https://www.togetherplatform.com/) and [Chronus](https://chronus.com/):

1. **Rich participant profiles** with demographics, tenure, location, interests
2. **Top matching criteria:** Work experience, discipline, soft/hard skills, career goals, language, location/timezone
3. **Progressive disclosure:** Start with minimal fields, expand as needed
4. **Limit search filters initially** to prevent "no results" frustration

---

## Current State Analysis

### Existing User Model

```prisma
model User {
  id                   String    @id @default(cuid())
  name                 String?
  email                String?   @unique
  emailVerified        DateTime?
  image                String?
  phone                String?   @unique
  address              String?
  password             String?
  passwordResetToken   String?   @unique
  passwordResetExpires DateTime?
  onlineStatus         Boolean   @default(false)
  timezone             String?
  onboardingCompleted  Boolean?  @default(false)
  role                 UserRole? @default(CONSULTEE)
  // ... relations
}
```

### Existing ConsultantProfile

```prisma
model ConsultantProfile {
  id             String  @id @default(uuid())
  description    String? @db.Text
  qualifications String?           // TO BE REMOVED
  specialization String?           // TO BE REMOVED
  experience     Float?
  rating         Float   @default(0)

  domain     Domain
  subDomains SubDomain[]
  tags       Tag[]

  scheduleType ScheduleType
  slotsOfAvailabilityWeekly SlotOfAvailabilityWeekly[]
  slotsOfAvailabilityCustom SlotOfAvailabilityCustom[]
  // ... plans and relations
}
```

### Existing ConsulteeProfile

```prisma
model ConsulteeProfile {
  id                           String            @id @default(uuid())
  education                    String?
  occupation                   String?
  aboutMe                      String?
  preferredCommunicationMethod ConsultationMode? @default(VIDEO)
  preferredLanguage            String?
  specialRequirements          String?           // TO BE REMOVED
  interests                    String?           // TO BE REMOVED
  goals                        String?
  // ... relations
}
```

### Existing StaffProfile

```prisma
model StaffProfile {
  id               String  @id @default(uuid())
  department       String?
  position         String?
  permissions      Json?
  responsibilities Json?
  // ... relations
}
```

### Missing: AdminProfile

**Critical Gap:** There is currently no AdminProfile model. Admins use the base User model with `role: ADMIN` but have no dedicated profile for admin-specific data.

---

## Proposed Changes

### Overview

| Category          | Action | Count |
| ----------------- | ------ | ----- |
| New Models        | Create | 4     |
| New Fields        | Add    | 25+   |
| Deprecated Fields | Remove | 4     |
| New Enums         | Create | 5     |

---

## New Models

### 1. WorkExperience

Tracks professional work history for consultants.

```prisma
model WorkExperience {
  id          String    @id @default(uuid())
  company     String
  title       String
  location    String?
  startDate   DateTime
  endDate     DateTime?
  isCurrent   Boolean   @default(false)
  description String?   @db.Text

  consultantProfile   ConsultantProfile @relation(fields: [consultantProfileId], references: [id], onDelete: Cascade)
  consultantProfileId String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([consultantProfileId])
}
```

### 2. Certification

Tracks professional certifications for consultants.

```prisma
model Certification {
  id                  String    @id @default(uuid())
  name                String
  issuingOrganization String
  issueDate           DateTime
  expiryDate          DateTime?
  credentialId        String?
  credentialUrl       String?

  consultantProfile   ConsultantProfile @relation(fields: [consultantProfileId], references: [id], onDelete: Cascade)
  consultantProfileId String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([consultantProfileId])
}
```

### 3. Education

Tracks educational background for both consultants and consultees.

```prisma
model Education {
  id           String  @id @default(uuid())
  institution  String
  degree       String
  fieldOfStudy String?
  startYear    Int?
  endYear      Int?
  grade        String?
  activities   String?
  description  String? @db.Text

  consultantProfile   ConsultantProfile? @relation(fields: [consultantProfileId], references: [id], onDelete: Cascade)
  consultantProfileId String?

  consulteeProfile   ConsulteeProfile? @relation(fields: [consulteeProfileId], references: [id], onDelete: Cascade)
  consulteeProfileId String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([consultantProfileId])
  @@index([consulteeProfileId])
}
```

### 4. AdminProfile

New model for admin-specific data.

```prisma
model AdminProfile {
  id             String     @id @default(uuid())
  adminLevel     AdminLevel
  accessScope    Json?      // Granular permissions
  assignedRegions String[]  // Geographic or domain regions
  notes          String?    @db.Text

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId String @unique

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([adminLevel])
}
```

---

## Field Additions

### User Model Additions

| Field         | Type      | Required | Description                       |
| ------------- | --------- | -------- | --------------------------------- |
| `dateOfBirth` | DateTime? | No       | User's date of birth              |
| `gender`      | Gender?   | No       | Gender identity                   |
| `city`        | String?   | No       | City of residence                 |
| `country`     | String?   | No       | Country of residence              |
| `linkedinUrl` | String?   | No       | LinkedIn profile URL              |
| `bio`         | String?   | No       | Short tagline/bio (max 160 chars) |

### ConsultantProfile Additions

| Field                         | Type          | Required | Description                           |
| ----------------------------- | ------------- | -------- | ------------------------------------- |
| `headline`                    | String?       | No       | Professional headline (max 120 chars) |
| `websiteUrl`                  | String?       | No       | Personal/portfolio website            |
| `twitterUrl`                  | String?       | No       | Twitter/X profile                     |
| `githubUrl`                   | String?       | No       | GitHub profile                        |
| `videoIntroUrl`               | String?       | No       | Introduction video URL                |
| `languages`                   | String[]      | No       | Languages spoken                      |
| `toolsAndTechnologies`        | String[]      | No       | Tools and tech expertise              |
| `mentoringStyle`              | String?       | No       | Description of mentoring approach     |
| `sessionTypes`                | SessionType[] | No       | Preferred session types (optional)    |
| `profileCompletionPercentage` | Int           | No       | Auto-calculated completion %          |
| `isVerified`                  | Boolean       | No       | Profile verification status           |
| `totalMenteesHelped`          | Int           | No       | Track record counter                  |

### ConsulteeProfile Additions

| Field              | Type              | Required | Description             |
| ------------------ | ----------------- | -------- | ----------------------- |
| `careerStage`      | CareerStage?      | No       | Current career stage    |
| `currentCompany`   | String?           | No       | Current employer        |
| `industry`         | String?           | No       | Industry sector         |
| `skillsToDevelop`  | String[]          | No       | Target skills to learn  |
| `linkedinUrl`      | String?           | No       | LinkedIn profile URL    |
| `budgetPreference` | BudgetPreference? | No       | Budget range preference |

### StaffProfile Additions

| Field          | Type      | Required | Description              |
| -------------- | --------- | -------- | ------------------------ |
| `employeeId`   | String?   | No       | Internal employee ID     |
| `hireDate`     | DateTime? | No       | Date of hire             |
| `reportsTo`    | String?   | No       | Manager's user ID        |
| `skills`       | String[]  | No       | Professional skills      |
| `workSchedule` | String?   | No       | Work schedule/shift info |

---

## Field Removals

Fields to be deprecated and removed:

| Model             | Field                 | Reason                                                  |
| ----------------- | --------------------- | ------------------------------------------------------- |
| ConsultantProfile | `qualifications`      | Replaced by Certification model                         |
| ConsultantProfile | `specialization`      | Redundant with subDomains + tags + headline             |
| ConsulteeProfile  | `specialRequirements` | Merge into `goals` or `aboutMe`                         |
| ConsulteeProfile  | `interests`           | Redundant with `skillsToDevelop` and domain preferences |

### Migration Strategy for Removals

1. **Phase 1:** Add new fields, mark old fields as `@deprecated` in comments
2. **Phase 2:** Migrate existing data to new structures
3. **Phase 3:** Update all code to use new fields
4. **Phase 6:** Remove deprecated fields from schema

---

## New Enums

### CareerStage

```prisma
enum CareerStage {
  STUDENT
  EARLY_CAREER    // 0-3 years experience
  MID_CAREER      // 3-10 years experience
  SENIOR          // 10+ years experience
  EXECUTIVE       // C-level or equivalent
}
```

### AdminLevel

```prisma
enum AdminLevel {
  SUPER_ADMIN
  ADMIN
  MODERATOR
}
```

### Gender

```prisma
enum Gender {
  MALE
  FEMALE
  NON_BINARY
  PREFER_NOT_TO_SAY
}
```

### BudgetPreference

```prisma
enum BudgetPreference {
  BUDGET      // Looking for affordable options
  MODERATE    // Mid-range pricing
  PREMIUM     // Willing to pay for premium
  FLEXIBLE    // No specific preference
}
```

### SessionType

```prisma
enum SessionType {
  ONE_ON_ONE      // 1:1 video/audio sessions
  GROUP           // Group sessions
  ASYNC_REVIEW    // Asynchronous document/code review
}
```

---

## Admin Role System

### Role Definitions

#### SUPER_ADMIN

**Full system access with no restrictions.**

| Permission Category | Access                                                          |
| ------------------- | --------------------------------------------------------------- |
| User Management     | Create, read, update, delete ALL users including other admins   |
| Financial           | Full access to payments, refunds, disputes; can process refunds |
| System Config       | Modify application settings, feature flags                      |
| Content             | Manage domains, subdomains, tags, topics                        |
| Data                | Export all data, view audit logs                                |
| Support             | Handle all support tickets, moderate all content                |

#### ADMIN

**High-level management with some restrictions.**

| Permission Category | Access                                                            |
| ------------------- | ----------------------------------------------------------------- |
| User Management     | Manage staff, consultants, consultees; cannot modify other admins |
| Financial           | View reports, handle disputes/refunds up to threshold             |
| System Config       | Limited access to non-critical settings                           |
| Content             | Full content management                                           |
| Data                | View reports, limited export                                      |
| Support             | Handle escalated support tickets                                  |

#### MODERATOR

**Day-to-day operations focus.**

| Permission Category | Access                                                     |
| ------------------- | ---------------------------------------------------------- |
| User Management     | View profiles, limited editing (e.g., verification status) |
| Financial           | No access                                                  |
| System Config       | No access                                                  |
| Content             | Moderate reviews, feedback; flag inappropriate content     |
| Data                | View operational dashboards only                           |
| Support             | Handle standard support tickets                            |

### Access Scope JSON Structure

```typescript
interface AccessScope {
  users: {
    create: boolean;
    read: boolean;
    update: boolean;
    delete: boolean;
    roles: UserRole[]; // Which roles can they manage
  };
  financial: {
    viewPayments: boolean;
    processRefunds: boolean;
    refundLimit?: number; // Max refund amount
    handleDisputes: boolean;
  };
  content: {
    manageDomains: boolean;
    moderateReviews: boolean;
    manageTopics: boolean;
  };
  system: {
    viewLogs: boolean;
    exportData: boolean;
    modifySettings: boolean;
  };
  support: {
    viewTickets: boolean;
    respondTickets: boolean;
    escalateTickets: boolean;
    closeTickets: boolean;
  };
}
```

---

## UI/UX Simplification

### Current Issues

1. **Complex theme system** with 7+ themes and festival detection
2. **Glassmorphism effects** that may impact performance
3. **Animated blob backgrounds** that are distracting
4. **Too many form fields** displayed at once

### Proposed Changes

#### Remove

- Festival-based auto theme switching
- Animated blob backgrounds
- Excessive glassmorphism effects
- Complex gradient systems

#### Implement

- **Clean, minimal card-based design**
- **White/light backgrounds** with subtle shadows
- **Progressive disclosure** - show relevant fields based on selections
- **Clear section groupings** with descriptive headers
- **Inline validation** with helpful error messages
- **Progress indicator** showing completion percentage
- **Save draft** functionality

### New Onboarding Flow

```
Step 1: Basic Info
├── Name, Email (pre-filled if signed in)
├── Phone, City, Country
└── Role Selection (determines next steps)

Step 2: Profile Details (role-specific)
├── Consultant: Headline, Bio, Domain selection
├── Consultee: Career stage, Current company, Goals
├── Staff: Department, Position, Employee ID
└── Admin: Admin level (assigned by super admin)

Step 3: Professional Background (Consultant/Consultee)
├── Add Education entries
├── Add Work Experience (Consultant)
└── Add Certifications (Consultant)

Step 4: Preferences
├── Communication preferences
├── Notification settings
└── Availability (Consultant only)

Step 5: Review & Complete
├── Summary of all entered data
├── Edit links for each section
└── Submit button
```

---

## Implementation Phases

### Phase 1: Schema Enhancement

**Duration estimate: Not applicable - focusing on what, not when**

**Tasks:**

- [ ] Create WorkExperience model
- [ ] Create Certification model
- [ ] Create Education model
- [ ] Create AdminProfile model
- [ ] Add new fields to User model
- [ ] Add new fields to ConsultantProfile
- [ ] Add new fields to ConsulteeProfile
- [ ] Add new fields to StaffProfile
- [ ] Add new enums
- [ ] Update User model with AdminProfile relation
- [ ] Run Prisma migration
- [ ] Update seed data

**Files affected:**

- `prisma/schema.prisma`
- `prisma/seed.ts`

### Phase 2: Zod & Validation

**Tasks:**

- [ ] Create WorkExperienceSchema
- [ ] Create CertificationSchema
- [ ] Create EducationSchema
- [ ] Create AdminProfileSchema
- [ ] Update UserSchema with new fields
- [ ] Update ConsultantProfileSchema
- [ ] Update ConsulteeProfileSchema
- [ ] Update StaffProfileSchema
- [ ] Update onboarding validation schemas
- [ ] Add enum validation

**Files affected:**

- `schemas/user.ts`
- `utils/onboarding.ts`
- New: `schemas/professional.ts` (for experience, certification, education)

### Phase 3: Simplified Onboarding UI

**Tasks:**

- [ ] Remove theme system files
- [ ] Create new minimal form components
- [ ] Implement progressive multi-step form
- [ ] Add Education management UI
- [ ] Add Work Experience management UI (Consultant)
- [ ] Add Certification management UI (Consultant)
- [ ] Implement form validation with new schemas
- [ ] Add draft save functionality
- [ ] Improve error messages

**Files affected:**

- `app/form/onboarding/page.tsx`
- `app/form/onboarding/themes.ts` (DELETE)
- `app/form/onboarding/themeUtils.ts` (DELETE)
- `app/form/onboarding/useTheme.ts` (DELETE)
- All form components in `app/form/onboarding/`

### Phase 4: API & Server Actions

**Tasks:**

- [ ] Create CRUD endpoints for WorkExperience
- [ ] Create CRUD endpoints for Certification
- [ ] Create CRUD endpoints for Education
- [ ] Create CRUD endpoints for AdminProfile
- [ ] Update User API routes
- [ ] Update ConsultantProfile API routes
- [ ] Update ConsulteeProfile API routes
- [ ] Update StaffProfile API routes
- [ ] Update onboarding server action
- [ ] Add proper error handling

**Files affected:**

- `app/api/user/[id]/route.ts`
- `app/api/user/consultants/[id]/route.ts`
- `app/api/user/consultees/[id]/route.ts`
- `app/api/user/staff/[id]/route.ts`
- New: `app/api/user/consultants/[id]/experience/route.ts`
- New: `app/api/user/consultants/[id]/certifications/route.ts`
- New: `app/api/user/education/route.ts`
- New: `app/api/user/admin/[id]/route.ts`
- `actions/forms/onboarding.action.ts`
- `utils/onboarding.ts`

### Phase 5: Settings Forms

**Tasks:**

- [ ] Update Consultant settings with new fields
- [ ] Add Experience management to Consultant settings
- [ ] Add Certification management to Consultant settings
- [ ] Update Consultee settings with new fields
- [ ] Add Education management to both Consultant/Consultee settings
- [ ] Update Staff settings with new fields
- [ ] Create Admin settings page (NEW)
- [ ] Implement proper loading states
- [ ] Add success/error toast notifications

**Files affected:**

- `app/dashboard/consultant/[consultantId]/(features)/settings/SettingsTab.tsx`
- `app/dashboard/consultee/[consulteeId]/(features)/settings/SettingsTab.tsx`
- `app/dashboard/staff/[staffId]/(features)/settings/page.tsx`
- New: `app/dashboard/admin/[adminId]/(features)/settings/page.tsx`

### Phase 6: Dashboard Fixes & Cleanup

**Tasks:**

- [ ] Complete Staff dashboard features
- [ ] Complete Admin dashboard features
- [ ] Add admin user management UI
- [ ] Add admin financial overview
- [ ] Remove deprecated fields from schema
- [ ] Run final migration
- [ ] Update all error messages to be user-friendly
- [ ] Add comprehensive form validation messages
- [ ] Test all flows end-to-end

**Files affected:**

- `app/dashboard/staff/[staffId]/`
- `app/dashboard/admin/[adminId]/`
- `prisma/schema.prisma` (remove deprecated fields)

---

## Migration Strategy

### Data Migration for Deprecated Fields

#### ConsultantProfile.qualifications -> Certification

```typescript
// Migration script pseudocode
const consultants = await prisma.consultantProfile.findMany({
  where: { qualifications: { not: null } },
});

for (const consultant of consultants) {
  // Parse qualifications string and create Certification entries
  const certs = parseQualifications(consultant.qualifications);
  await prisma.certification.createMany({
    data: certs.map((cert) => ({
      ...cert,
      consultantProfileId: consultant.id,
    })),
  });
}
```

#### ConsulteeProfile.interests -> skillsToDevelop

```typescript
// Direct field mapping
await prisma.$executeRaw`
  UPDATE "ConsulteeProfile"
  SET "skillsToDevelop" = ARRAY[interests]
  WHERE interests IS NOT NULL
`;
```

### Rollback Considerations

- Keep deprecated fields until Phase 6
- Create database backups before each migration
- Test migrations in staging environment first

---

## API Changes

### New Endpoints

| Method     | Endpoint                                             | Description                   |
| ---------- | ---------------------------------------------------- | ----------------------------- |
| GET/POST   | `/api/user/consultants/[id]/experience`              | List/create work experience   |
| PUT/DELETE | `/api/user/consultants/[id]/experience/[expId]`      | Update/delete experience      |
| GET/POST   | `/api/user/consultants/[id]/certifications`          | List/create certifications    |
| PUT/DELETE | `/api/user/consultants/[id]/certifications/[certId]` | Update/delete certification   |
| GET/POST   | `/api/user/[id]/education`                           | List/create education entries |
| PUT/DELETE | `/api/user/[id]/education/[eduId]`                   | Update/delete education       |
| GET/PUT    | `/api/user/admin/[id]`                               | Get/update admin profile      |

### Updated Endpoints

| Method    | Endpoint                     | Changes                                             |
| --------- | ---------------------------- | --------------------------------------------------- |
| GET/PUT   | `/api/user/[id]`             | Add new User fields                                 |
| GET/PUT   | `/api/user/consultants/[id]` | Add new ConsultantProfile fields, include relations |
| GET/PATCH | `/api/user/consultees/[id]`  | Add new ConsulteeProfile fields                     |
| GET/PUT   | `/api/user/staff/[id]`       | Add new StaffProfile fields                         |

---

## Testing Strategy

### Unit Tests

- [ ] Zod schema validation for all new schemas
- [ ] API route handlers with mock data
- [ ] Server action functions

### Integration Tests

- [ ] Onboarding flow end-to-end
- [ ] Settings update flow for each role
- [ ] CRUD operations for nested models

### Manual Testing Checklist

- [ ] Create new user for each role
- [ ] Complete onboarding for each role
- [ ] Add/edit/delete work experience
- [ ] Add/edit/delete certifications
- [ ] Add/edit/delete education
- [ ] Update settings for each dashboard
- [ ] Verify admin role permissions
- [ ] Test error messages display correctly

---

## Rollback Plan

### If Issues Occur

1. **Schema Issues:** Revert migration using `prisma migrate reset` (dev) or restore from backup (prod)
2. **API Issues:** Deploy previous version of API routes
3. **UI Issues:** Revert component changes, re-enable old theme system if needed

### Backup Strategy

- Full database backup before each phase
- Git tags for each phase completion
- Feature flags for gradual rollout (if available)

---

## Appendix

### A. Field Validation Rules

| Field           | Validation                                       |
| --------------- | ------------------------------------------------ |
| `bio`           | Max 160 characters                               |
| `headline`      | Max 120 characters                               |
| `linkedinUrl`   | Valid URL, must contain linkedin.com             |
| `twitterUrl`    | Valid URL, must contain twitter.com or x.com     |
| `githubUrl`     | Valid URL, must contain github.com               |
| `websiteUrl`    | Valid URL                                        |
| `videoIntroUrl` | Valid URL (YouTube, Vimeo, or direct video link) |
| `dateOfBirth`   | Must be in the past, user must be 13+ years old  |

### B. Profile Completion Calculation

```typescript
function calculateProfileCompletion(profile: ConsultantProfile): number {
  const fields = {
    headline: 10,
    description: 15,
    domain: 10,
    subDomains: 10,
    languages: 5,
    toolsAndTechnologies: 10,
    workExperiences: 15, // At least 1
    certifications: 10, // At least 1
    education: 10, // At least 1
    scheduleType: 5,
  };

  let completed = 0;
  // Calculate based on filled fields...
  return completed;
}
```

### C. Error Message Guidelines

| Context         | Bad Example    | Good Example                                                                              |
| --------------- | -------------- | ----------------------------------------------------------------------------------------- |
| Required field  | "Required"     | "Please enter your name"                                                                  |
| Invalid email   | "Invalid"      | "Please enter a valid email address (e.g., name@example.com)"                             |
| URL validation  | "Invalid URL"  | "Please enter a valid LinkedIn URL (e.g., linkedin.com/in/yourprofile)"                   |
| Date validation | "Invalid date" | "Please select a date in the past"                                                        |
| Server error    | "Error"        | "Unable to save your changes. Please try again or contact support if the issue persists." |

---

## Changelog

| Version | Date        | Changes               |
| ------- | ----------- | --------------------- |
| 1.0     | Dec 6, 2025 | Initial plan document |
