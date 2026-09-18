/**
 * Which wizard step owns each payload field, and the words the customer sees
 * for it. The final submit validates the whole payload at once, so a refusal
 * has to be sent back to the step that can fix it, named in plain words —
 * "Missing or invalid: weeklySlots > 2 > endTime" helped nobody.
 */

export type OnboardingStepKey =
  | "personal"
  | "professional"
  | "availability"
  | "agreement"
  | "roleDetails"
  | "review"
  | "org";

const STEP_OF: Record<string, OnboardingStepKey> = {
  // Step 0 — the account and the role.
  name: "personal",
  email: "personal",
  phone: "personal",
  address: "personal",
  timezone: "personal",
  gender: "personal",
  city: "personal",
  country: "personal",
  linkedinUrl: "personal",
  bio: "personal",
  dateOfBirth: "personal",
  image: "personal",
  role: "personal",
  // Consultant professional profile (expertise + background tabs).
  description: "professional",
  headline: "professional",
  experience: "professional",
  domain: "professional",
  domainId: "professional",
  subDomains: "professional",
  tags: "professional",
  languages: "professional",
  toolsAndTechnologies: "professional",
  offeringFormats: "professional",
  workExperiences: "professional",
  educationHistory: "professional",
  certificationsList: "professional",
  achievements: "professional",
  // Availability.
  scheduleType: "availability",
  weeklySlots: "availability",
  customSlots: "availability",
  // Agreement (+ verification for consultants; + profile for consultees).
  termsAccepted: "agreement",
  privacyAccepted: "agreement",
  termsAcceptedAt: "agreement",
  privacyAcceptedAt: "agreement",
  verificationLinkedinUrl: "agreement",
  verificationNotes: "agreement",
  verificationDocuments: "agreement",
  aboutMe: "agreement",
  skillsToDevelop: "agreement",
  consulteeInlineEducation: "agreement",
  consulteeInlineWorkExperience: "agreement",
  // Staff.
  department: "roleDetails",
  position: "roleDetails",
};

const LABEL_OF: Record<string, string> = {
  name: "Full name",
  email: "Email",
  phone: "Phone number",
  address: "Address",
  timezone: "Time zone",
  gender: "Gender",
  city: "City",
  country: "Country",
  linkedinUrl: "LinkedIn URL",
  bio: "Short bio",
  dateOfBirth: "Date of birth",
  image: "Profile photo",
  role: "How you'll use Familiarise",
  description: "About your expertise",
  headline: "Professional headline",
  experience: "Years of experience",
  domain: "Field of expertise",
  domainId: "Field of expertise",
  subDomains: "Specialties",
  tags: "Skills",
  languages: "Languages",
  toolsAndTechnologies: "Tools and technologies",
  offeringFormats: "Offering formats",
  workExperiences: "Work experience",
  educationHistory: "Education",
  certificationsList: "Certifications",
  achievements: "Achievements and portfolio",
  scheduleType: "Schedule type",
  weeklySlots: "Weekly hours",
  customSlots: "Custom dates",
  termsAccepted: "Terms of service",
  privacyAccepted: "Privacy policy",
  termsAcceptedAt: "Terms of service",
  privacyAcceptedAt: "Privacy policy",
  verificationLinkedinUrl: "LinkedIn profile for verification",
  verificationNotes: "Verification notes",
  verificationDocuments: "Verification documents",
  aboutMe: "About me",
  skillsToDevelop: "Skills to develop",
  consulteeInlineEducation: "Education",
  consulteeInlineWorkExperience: "Work experience",
  department: "Department",
  position: "Position",
};

/** The step that owns a top-level payload field, or null for an unknown one. */
export function stepKeyForField(field: string): OnboardingStepKey | null {
  return STEP_OF[field] ?? null;
}

/** "Weekly hours (row 3)", never an internal key. */
export function describeIssuePath(path: readonly (string | number)[]): string {
  const [head, ...rest] = path;
  if (typeof head !== "string") return "A field";
  const label = LABEL_OF[head] ?? "A field";
  const index = rest.find((p): p is number => typeof p === "number");
  return index === undefined ? label : `${label} (row ${index + 1})`;
}

export interface FieldIssue {
  path: readonly (string | number)[];
  message: string;
}

/**
 * Groups a Zod error list by owning step, in step order, with each field
 * named once. The first group is where the wizard sends the user.
 */
export function summarizeIssues(
  issues: readonly FieldIssue[],
  stepOrder: readonly OnboardingStepKey[],
): { stepKey: OnboardingStepKey | null; lines: string[] }[] {
  const byStep = new Map<OnboardingStepKey | null, Map<string, string>>();
  for (const issue of issues) {
    const head = typeof issue.path[0] === "string" ? issue.path[0] : "";
    const key = stepKeyForField(head);
    const label = describeIssuePath(issue.path);
    const bucket = byStep.get(key) ?? new Map<string, string>();
    if (!bucket.has(label)) bucket.set(label, issue.message);
    byStep.set(key, bucket);
  }
  const ordered: (OnboardingStepKey | null)[] = [...stepOrder, null];
  return ordered
    .filter((k) => byStep.has(k))
    .map((k) => ({
      stepKey: k,
      lines: [...(byStep.get(k) ?? [])].map(([label, msg]) =>
        msg ? `${label}: ${msg}` : label,
      ),
    }));
}
