export interface OrgWizardData {
  // Step 0: Org Info
  name: string;
  kind: "BUYER" | "PROVIDER" | "HYBRID";
  description: string;
  industry: string;
  sizeBucket: string;
  website: string;
  billingEmail: string;

  // Step 1: Billing & Seats (BUYER/HYBRID only)
  billingMode: "TAG_ONLY" | "SEAT_PACK" | "INVOICED_MONTHLY" | "PREPAID_UNLIMITED";
  paymentTermsDays: number;
  seatsTotal: number | null;

  // Step 1 alt: Revenue Rates (PROVIDER/HYBRID only)
  platformCommissionRate: number;
  orgRetainRate: number;
  consultantPayoutRate: number;

  // Step 2: Branding
  logo: string | null;
  bannerImage: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;

  // Step 3: Invite Team
  inviteEmails: string[];
  inviteRole: string;

  // Internal (set after step 0 creates the org)
  orgId: string | null;
  orgProfileId: string | null;
}

export interface StepProps {
  onNext: (data: Partial<OrgWizardData>) => void;
  onBack: () => void;
  onGoToStep?: (step: number) => void;
  initialData: Partial<OrgWizardData>;
  isSubmitting?: boolean;
}
