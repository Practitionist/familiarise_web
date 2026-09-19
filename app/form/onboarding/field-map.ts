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

/** [owning step, on-screen label] per top-level payload field. */
const FIELDS: Record<string, [OnboardingStepKey, string]> = {
  // Step 0 — the account and the role.
  name: ["personal", "Full name"],
  email: ["personal", "Email"],
  phone: ["personal", "Phone number"],
  address: ["personal", "Address"],
  timezone: ["personal", "Time zone"],
  gender: ["personal", "Gender"],
  city: ["personal", "City"],
  country: ["personal", "Country"],
  linkedinUrl: ["personal", "LinkedIn URL"],
  bio: ["personal", "Short bio"],
  dateOfBirth: ["personal", "Date of birth"],
  image: ["personal", "Profile photo"],
  role: ["personal", "How you'll use Familiarise"],
  // Consultant professional profile (expertise + background tabs).
  description: ["professional", "About your expertise"],
  headline: ["professional", "Professional headline"],
  experience: ["professional", "Years of experience"],
  domain: ["professional", "Field of expertise"],
  domainId: ["professional", "Field of expertise"],
  subDomains: ["professional", "Specialties"],
  tags: ["professional", "Skills"],
  languages: ["professional", "Languages"],
  toolsAndTechnologies: ["professional", "Tools and technologies"],
  offeringFormats: ["professional", "Offering formats"],
  workExperiences: ["professional", "Work experience"],
  educationHistory: ["professional", "Education"],
  certificationsList: ["professional", "Certifications"],
  achievements: ["professional", "Achievements and portfolio"],
  // Availability.
  scheduleType: ["availability", "Schedule type"],
  weeklySlots: ["availability", "Weekly hours"],
  customSlots: ["availability", "Custom dates"],
  // Agreement (+ verification for consultants; + profile for consultees).
  termsAccepted: ["agreement", "Terms of service"],
  privacyAccepted: ["agreement", "Privacy policy"],
  termsAcceptedAt: ["agreement", "Terms of service"],
  privacyAcceptedAt: ["agreement", "Privacy policy"],
  verificationLinkedinUrl: ["agreement", "LinkedIn profile for verification"],
  verificationNotes: ["agreement", "Verification notes"],
  verificationDocuments: ["agreement", "Verification documents"],
  aboutMe: ["agreement", "About me"],
  skillsToDevelop: ["agreement", "Skills to develop"],
  consulteeInlineEducation: ["agreement", "Education"],
  consulteeInlineWorkExperience: ["agreement", "Work experience"],
  // Staff.
  department: ["roleDetails", "Department"],
  position: ["roleDetails", "Position"],
};

/** The step that owns a top-level payload field, or null for an unknown one. */
export function stepKeyForField(field: string): OnboardingStepKey | null {
  return FIELDS[field]?.[0] ?? null;
}

/** "Weekly hours (row 3)", never an internal key. */
export function describeIssuePath(path: readonly (string | number)[]): string {
  const [head, ...rest] = path;
  if (typeof head !== "string") return "A field";
  const label = FIELDS[head]?.[1] ?? "A field";
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
