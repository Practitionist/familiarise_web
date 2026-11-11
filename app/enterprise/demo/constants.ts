export const DEMO_USE_CASE_VALUES = [
  "team-training",
  "corporate-mentorship",
  "institution",
  "other",
] as const;
export const DEMO_TEAM_SIZE_VALUES = [
  "1-10",
  "11-50",
  "51-200",
  "201-1000",
  "1000+",
] as const;
export const DEMO_BUDGET_BAND_VALUES = [
  "under-5l",
  "5l-25l",
  "25l-1cr",
  "1cr+",
  "not-sure",
] as const;

export type DemoUseCase = (typeof DEMO_USE_CASE_VALUES)[number];

const USE_CASE_LABELS: Record<DemoUseCase, string> = {
  "team-training": "Team training program",
  "corporate-mentorship": "Corporate mentorship",
  institution: "College or institution",
  other: "Something else",
};
const TEAM_SIZE_LABELS: Record<(typeof DEMO_TEAM_SIZE_VALUES)[number], string> =
  {
    "1-10": "1 to 10 people",
    "11-50": "11 to 50 people",
    "51-200": "51 to 200 people",
    "201-1000": "201 to 1,000 people",
    "1000+": "More than 1,000 people",
  };
const BUDGET_BAND_LABELS: Record<
  (typeof DEMO_BUDGET_BAND_VALUES)[number],
  string
> = {
  "under-5l": "Under ₹5 lakh",
  "5l-25l": "₹5 lakh to ₹25 lakh",
  "25l-1cr": "₹25 lakh to ₹1 crore",
  "1cr+": "Above ₹1 crore",
  "not-sure": "Not sure yet",
};

export const DEMO_USE_CASES = DEMO_USE_CASE_VALUES.map((value) => ({
  value,
  label: USE_CASE_LABELS[value],
}));
export const DEMO_TEAM_SIZES = DEMO_TEAM_SIZE_VALUES.map((value) => ({
  value,
  label: TEAM_SIZE_LABELS[value],
}));
export const DEMO_BUDGET_BANDS = DEMO_BUDGET_BAND_VALUES.map((value) => ({
  value,
  label: BUDGET_BAND_LABELS[value],
}));

/** Team training has its own lead category; every other use case is "enterprise". */
export function demoLeadCategory(
  useCase: DemoUseCase,
): "team-training" | "enterprise" {
  return useCase === "team-training" ? "team-training" : "enterprise";
}
