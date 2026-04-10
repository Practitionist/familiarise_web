"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, X } from "lucide-react";
import { z } from "zod";
import type { OnboardingFormData } from "@/utils/onboarding";

interface Props {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
}

const BILLING_MODES = [
  {
    value: "TAG_ONLY",
    label: "Tag-only",
    description:
      "Learners pay at checkout with their own card. Payments are tagged to your organization for reporting and analytics. No org-level billing.",
  },
  {
    value: "SEAT_PACK",
    label: "Seat pack",
    description:
      "Your organization pre-purchases a credit pool. When learners book, credits are deducted automatically. Top up anytime from the dashboard.",
  },
  {
    value: "INVOICED_MONTHLY",
    label: "Invoiced monthly",
    description:
      "Learners book freely throughout the month. At month-end, your org receives one consolidated invoice. Pay within your configured NET terms.",
  },
];

const INDUSTRIES = [
  "Education", "Technology", "Healthcare", "Finance",
  "Legal", "Government", "Non-profit", "Manufacturing", "Consulting", "Other",
];

const SIZE_BUCKETS = [
  { value: "SMALL_1_50", label: "1-50 employees" },
  { value: "MEDIUM_51_200", label: "51-200 employees" },
  { value: "LARGE_201_1000", label: "201-1000 employees" },
  { value: "ENTERPRISE_1000_PLUS", label: "1000+ employees" },
];

const INVITE_ROLES = [
  { value: "ORG_LEARNER", label: "Learner" },
  { value: "ORG_MANAGER", label: "Manager" },
  { value: "ORG_ADMIN", label: "Admin" },
];

export default function OrgAdminOrgSetupStep({
  onNext,
  onBack,
  initialData,
}: Props) {
  const [orgName, setOrgName] = useState(initialData.orgName ?? "");
  const [orgBillingEmail, setOrgBillingEmail] = useState(
    initialData.orgBillingEmail ?? "",
  );
  const [orgBillingMode, setOrgBillingMode] = useState<string>(
    initialData.orgBillingMode ?? "TAG_ONLY",
  );
  const [orgDescription, setOrgDescription] = useState(
    initialData.orgDescription ?? "",
  );
  const [orgIndustry, setOrgIndustry] = useState(
    initialData.orgIndustry ?? "",
  );
  const [orgSizeBucket, setOrgSizeBucket] = useState(
    initialData.orgSizeBucket ?? "",
  );
  const [orgWebsite, setOrgWebsite] = useState(initialData.orgWebsite ?? "");
  const [orgPaymentTermsDays, setOrgPaymentTermsDays] = useState(
    String(initialData.orgPaymentTermsDays ?? 30),
  );
  const [orgSeatsTotal, setOrgSeatsTotal] = useState(
    initialData.orgSeatsTotal ? String(initialData.orgSeatsTotal) : "",
  );
  const [inviteEmails, setInviteEmails] = useState<string[]>(
    initialData.orgInviteEmails ?? [],
  );
  const [inviteRole, setInviteRole] = useState(
    initialData.orgInviteRole ?? "ORG_LEARNER",
  );
  const [rawEmails, setRawEmails] = useState("");
  const [error, setError] = useState<string | null>(null);

  const addEmails = () => {
    const candidates = rawEmails
      .split(/[,\n;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const c of candidates) {
      if (z.string().email().safeParse(c).success) {
        if (!inviteEmails.includes(c) && !valid.includes(c)) valid.push(c);
      } else {
        invalid.push(c);
      }
    }
    if (invalid.length) setError(`Invalid: ${invalid.join(", ")}`);
    else setError(null);
    if (valid.length) {
      setInviteEmails((prev) => [...prev, ...valid]);
      setRawEmails("");
    }
  };

  const handleSubmit = () => {
    if (!orgName.trim() || orgName.trim().length < 2) {
      setError("Organization name must be at least 2 characters.");
      return;
    }
    if (!orgBillingEmail.trim() || !orgBillingEmail.includes("@")) {
      setError("Please enter a valid billing email.");
      return;
    }
    setError(null);
    onNext({
      orgName: orgName.trim(),
      orgBillingEmail: orgBillingEmail.trim(),
      orgBillingMode: orgBillingMode as "TAG_ONLY" | "SEAT_PACK" | "INVOICED_MONTHLY",
      orgDescription: orgDescription.trim() || undefined,
      orgIndustry: orgIndustry || undefined,
      orgSizeBucket: orgSizeBucket || undefined,
      orgWebsite: orgWebsite.trim() || undefined,
      orgPaymentTermsDays: parseInt(orgPaymentTermsDays, 10) || 30,
      orgSeatsTotal: orgSeatsTotal ? parseInt(orgSeatsTotal, 10) : null,
      orgInviteEmails: inviteEmails,
      orgInviteRole: inviteRole,
    });
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Set up your organization. You can always adjust these settings later.
      </p>

      {/* Org basics */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-900">Organization details</h3>
        <div className="space-y-2">
          <Label htmlFor="orgName">Organization name *</Label>
          <Input
            id="orgName"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Acme School of Engineering"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="orgBillingEmail">Billing email *</Label>
          <Input
            id="orgBillingEmail"
            type="email"
            value={orgBillingEmail}
            onChange={(e) => setOrgBillingEmail(e.target.value)}
            placeholder="billing@acme.edu"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="orgDescription">Description</Label>
          <textarea
            id="orgDescription"
            value={orgDescription}
            onChange={(e) => setOrgDescription(e.target.value)}
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm min-h-16"
            placeholder="A short description of your organization"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Industry</Label>
            <Select value={orgIndustry} onValueChange={setOrgIndustry}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {INDUSTRIES.map((i) => (
                  <SelectItem key={i} value={i}>{i}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Size</Label>
            <Select value={orgSizeBucket} onValueChange={setOrgSizeBucket}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {SIZE_BUCKETS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="orgWebsite">Website</Label>
          <Input
            id="orgWebsite"
            type="url"
            value={orgWebsite}
            onChange={(e) => setOrgWebsite(e.target.value)}
            placeholder="https://acme.edu"
          />
        </div>
      </div>

      {/* Billing */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-900">Billing</h3>
        <div className="space-y-2">
          <Label>Billing mode</Label>
          <div className="space-y-2">
            {BILLING_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setOrgBillingMode(m.value)}
                className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
                  orgBillingMode === m.value
                    ? "border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900"
                    : "border-zinc-200 hover:border-zinc-300"
                }`}
              >
                <div
                  className={`mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                    orgBillingMode === m.value
                      ? "border-zinc-900"
                      : "border-zinc-300"
                  }`}
                >
                  {orgBillingMode === m.value && (
                    <div className="w-2 h-2 rounded-full bg-zinc-900" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-900">
                    {m.label}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    {m.description}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
        {orgBillingMode === "INVOICED_MONTHLY" && (
          <div className="space-y-2">
            <Label htmlFor="orgPaymentTerms">Payment terms (days)</Label>
            <Input
              id="orgPaymentTerms"
              type="number"
              min={1}
              max={120}
              value={orgPaymentTermsDays}
              onChange={(e) => setOrgPaymentTermsDays(e.target.value)}
            />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="orgSeats">Seat budget (optional)</Label>
          <Input
            id="orgSeats"
            type="number"
            min={1}
            value={orgSeatsTotal}
            onChange={(e) => setOrgSeatsTotal(e.target.value)}
            placeholder="Leave blank for unlimited"
          />
        </div>
      </div>

      {/* Invite team */}
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-zinc-900">Invite team (optional)</h3>
        <div className="flex gap-2">
          <textarea
            value={rawEmails}
            onChange={(e) => setRawEmails(e.target.value)}
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm min-h-16 font-mono"
            placeholder={"alice@acme.com\nbob@acme.com"}
          />
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={addEmails}
            disabled={!rawEmails.trim()}
          >
            <Plus className="h-4 w-4 mr-1" /> Add
          </Button>
        </div>
        <p className="text-xs text-zinc-500">Comma, semicolon, or newline-separated.</p>

        {inviteEmails.length > 0 && (
          <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-2 border border-zinc-200 rounded-lg bg-zinc-50">
            {inviteEmails.map((email) => (
              <Badge key={email} variant="secondary" className="gap-1 pr-1">
                {email}
                <button
                  type="button"
                  onClick={() =>
                    setInviteEmails((prev) => prev.filter((e) => e !== email))
                  }
                  className="rounded-full hover:bg-zinc-300 p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <Label>Default role for invitees</Label>
          <Select value={inviteRole} onValueChange={setInviteRole}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              {INVITE_ROLES.map((r) => (
                <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" onClick={handleSubmit}>
          Next
        </Button>
      </div>
    </div>
  );
}
