"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Pencil } from "lucide-react";
import type { OnboardingFormData } from "@/utils/onboarding";

interface Props {
  onSubmit: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  formData: Partial<OnboardingFormData>;
  onGoToStep: (step: number) => void;
}

export default function OrgAdminReviewStep({
  onSubmit,
  onBack,
  formData,
  onGoToStep,
}: Props) {
  const Section = ({
    title,
    step,
    children,
  }: {
    title: string;
    step: number;
    children: React.ReactNode;
  }) => (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3 px-4">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onGoToStep(step)}
        >
          <Pencil className="h-3 w-3 mr-1" /> Edit
        </Button>
      </CardHeader>
      <CardContent className="px-4 pb-4 text-sm text-zinc-600 space-y-1">
        {children}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Review your details before creating your account and organization.
      </p>

      <Section title="Personal Info" step={0}>
        <p><strong>Name:</strong> {formData.name ?? "—"}</p>
        <p><strong>Email:</strong> {formData.email ?? "—"}</p>
        {formData.phone && <p><strong>Phone:</strong> {formData.phone}</p>}
        {formData.timezone && (
          <p><strong>Timezone:</strong> {formData.timezone}</p>
        )}
      </Section>

      <Section title="Organization" step={1}>
        <p><strong>Name:</strong> {formData.orgName ?? "—"}</p>
        <p><strong>Billing email:</strong> {formData.orgBillingEmail ?? "—"}</p>
        <p>
          <strong>Billing mode:</strong>{" "}
          <Badge variant="secondary">
            {formData.orgBillingMode ?? "TAG_ONLY"}
          </Badge>
        </p>
        {formData.orgDescription && (
          <p><strong>Description:</strong> {formData.orgDescription}</p>
        )}
        {formData.orgIndustry && (
          <p><strong>Industry:</strong> {formData.orgIndustry}</p>
        )}
        {formData.orgSizeBucket && (
          <p>
            <strong>Size:</strong>{" "}
            {formData.orgSizeBucket.replace(/_/g, " ").toLowerCase()}
          </p>
        )}
        {formData.orgWebsite && (
          <p><strong>Website:</strong> {formData.orgWebsite}</p>
        )}
        {formData.orgBillingMode === "INVOICED_MONTHLY" && (
          <p>
            <strong>Payment terms:</strong> NET-
            {formData.orgPaymentTermsDays ?? 30}
          </p>
        )}
        {formData.orgSeatsTotal && (
          <p><strong>Seat budget:</strong> {formData.orgSeatsTotal}</p>
        )}
      </Section>

      {(formData.orgInviteEmails?.length ?? 0) > 0 && (
        <Section title="Team Invitations" step={1}>
          <div className="flex flex-wrap gap-1">
            {formData.orgInviteEmails?.map((e) => (
              <Badge key={e} variant="outline" className="text-xs">{e}</Badge>
            ))}
          </div>
          <p className="text-xs text-zinc-500 mt-1">
            Role: {(formData.orgInviteRole ?? "ORG_LEARNER").replace("ORG_", "")}
          </p>
        </Section>
      )}

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={() => onSubmit(formData)}>
          Create Account & Organization
        </Button>
      </div>
    </div>
  );
}
