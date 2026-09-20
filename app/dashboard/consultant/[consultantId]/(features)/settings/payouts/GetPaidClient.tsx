"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Landmark, ReceiptText } from "lucide-react";

import { DashboardContent } from "@/components/dashboard/PageScaffold";
import { DashboardErrorBoundary } from "@/components/DashboardErrorBoundary";
import { SettingsSkeleton } from "@/components/dashboard/DashboardSkeletons";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import { toneBadge, type Tone } from "@/lib/dashboard/money-state";
import type {
  PayoutEligibilityReason,
  Requirement,
} from "@/lib/payments/payouts/payout-requirements";

import {
  fetchPayoutSetup,
  payoutSetupQueryKey,
  type PayoutAccountView,
  type PayoutSetup,
} from "./get-paid-api";
import { PayoutAccountForm, ReverifyAccountButton } from "./PayoutAccountForm";
import { ReversePennyDrop } from "./ReversePennyDrop";
import { TaxInfoForm } from "./TaxInfoForm";

/** The account card's four faces; the step list and the badge read the same word. */
type AccountFace = "NONE" | "PENDING" | "VERIFIED" | "FAILED";

const ACCOUNT_FACE: Record<AccountFace, { label: string; tone: Tone }> = {
  NONE: { label: "Not added", tone: "caution" },
  PENDING: { label: "Pending verification", tone: "info" },
  VERIFIED: { label: "Verified", tone: "success" },
  FAILED: { label: "Verification failed", tone: "warning" },
};

/** What the first failing gate means for the person reading it. */
const REASON_LINE: Record<PayoutEligibilityReason, string> = {
  LIVE_PAYOUTS_OFF:
    "Payouts begin at launch — your balance is safe with us. Set this up now so the first batch reaches you.",
  NON_INDIA:
    "We can only pay Indian bank accounts today; we will reach out about your payouts directly.",
  NO_ACCOUNT:
    "Add a bank account or UPI ID so we have somewhere to send your earnings.",
  UNVERIFIED:
    "Your account is waiting on the ₹1 verification before payouts can start.",
  BELOW_MINIMUM:
    "Payouts go out once your available balance reaches the minimum.",
};

export function accountFaceOf(
  account: PayoutAccountView | null,
  lastCheckFailed: boolean,
): AccountFace {
  if (!account) return "NONE";
  if (account.isVerified) return "VERIFIED";
  return lastCheckFailed ? "FAILED" : "PENDING";
}

/** The detail line shown under the account card after a reverify check. */
function describeReverifyResult(r: {
  accountStatus: string;
  registeredName?: string | null;
}): string | null {
  if (r.accountStatus === "invalid") {
    return "The bank reported this account as invalid.";
  }
  if (r.registeredName) {
    return `Bank has this account under "${r.registeredName}".`;
  }
  return null;
}

/** `•••• 1234` for a bank account, `ab••@upi` for a UPI id — never the whole thing. */
export function maskedAccountLabel(account: PayoutAccountView): string {
  if (account.accountType === "UPI" && account.upiId) {
    const [user, handle] = account.upiId.split("@");
    return `${user.slice(0, 2)}••••${handle ? `@${handle}` : ""}`;
  }
  const ifscSuffix = account.ifscCode ? ` · ${account.ifscCode}` : "";
  return `•••• ${account.accountNumberLast4 ?? "????"}${ifscSuffix}`;
}

function StepList({
  currentlyDue,
  eventuallyDue,
}: Readonly<{ currentlyDue: Requirement[]; eventuallyDue: Requirement[] }>) {
  if (currentlyDue.length === 0 && eventuallyDue.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
        Everything we need is in place.
      </p>
    );
  }
  const row = (r: Requirement, due: "now" | "later") => (
    <li key={r.code} className="flex items-center gap-2 text-sm">
      <Circle
        className={
          due === "now"
            ? "h-3.5 w-3.5 text-amber-600"
            : "h-3.5 w-3.5 text-muted-foreground/60"
        }
        aria-hidden
      />
      <a href={r.href} className="underline-offset-2 hover:underline">
        {r.label}
      </a>
      {due === "later" && (
        <span className="text-xs text-muted-foreground">later is fine</span>
      )}
    </li>
  );
  return (
    <ol className="space-y-1.5">
      {currentlyDue.map((r) => row(r, "now"))}
      {eventuallyDue.map((r) => row(r, "later"))}
    </ol>
  );
}

function SectionCard({
  id,
  icon: Icon,
  title,
  badge,
  children,
}: Readonly<{
  id: string;
  icon: typeof Landmark;
  title: string;
  badge: { label: string; tone: Tone };
  children: React.ReactNode;
}>) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-24 rounded-xl border border-border bg-card p-5"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2
          id={`${id}-heading`}
          className="flex items-center gap-2 text-base font-semibold"
        >
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
          {title}
        </h2>
        <StatusBadge {...toneBadge(badge.tone, badge.label)} size="sm" />
      </div>
      {children}
    </section>
  );
}

/**
 * The account card: none → the two ways in; pending → the penny-drop copy and
 * "Check again"; verified → the masked tail and "Change"; failed → the reason
 * and a retry. The full account number is never in this component's props.
 */
function AccountCard({
  consultantId,
  setup,
}: Readonly<{ consultantId: string; setup: PayoutSetup }>) {
  const defaultAccount =
    setup.accounts.find((a) => a.isDefault) ?? setup.accounts[0] ?? null;
  const [lastCheck, setLastCheck] = useState<{
    failed: boolean;
    detail: string | null;
  }>({ failed: false, detail: null });
  const [changing, setChanging] = useState(false);
  const face = accountFaceOf(defaultAccount, lastCheck.failed);
  const showForms = face === "NONE" || changing;

  return (
    <SectionCard
      id="account"
      icon={Landmark}
      title="Bank account or UPI"
      badge={ACCOUNT_FACE[face]}
    >
      {defaultAccount && !changing && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <div>
            <p className="font-medium">{maskedAccountLabel(defaultAccount)}</p>
            {defaultAccount.accountHolderName && (
              <p className="text-xs text-muted-foreground">
                {defaultAccount.accountHolderName}
                {defaultAccount.bankName ? ` · ${defaultAccount.bankName}` : ""}
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
      )}

      {face === "PENDING" && !changing && (
        <p className="mb-3 text-sm text-muted-foreground">
          {lastCheck.detail ??
            "We are confirming this account with a ₹1 test deposit. That usually takes a minute; check again below."}
        </p>
      )}
      {face === "FAILED" && !changing && (
        <p className="mb-3 text-sm text-amber-700">
          {lastCheck.detail ??
            "The bank did not confirm this account. Check the details and try again."}
        </p>
      )}
      {(face === "PENDING" || face === "FAILED") &&
        defaultAccount &&
        !changing && (
          <ReverifyAccountButton
            consultantId={consultantId}
            accountId={defaultAccount.id}
            onResult={(r) =>
              setLastCheck({
                failed: r.accountStatus === "invalid",
                detail: describeReverifyResult(r),
              })
            }
          />
        )}

      {showForms && (
        <div className="space-y-6">
          {!setup.razorpayConfigured && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Bank verification is not switched on for the platform yet, so
              details cannot be saved right now.
            </p>
          )}
          <ReversePennyDrop
            consultantId={consultantId}
            disabled={!setup.razorpayConfigured}
            onVerified={() => setChanging(false)}
          />
          <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> or enter it yourself{" "}
            <span className="h-px flex-1 bg-border" />
          </div>
          <PayoutAccountForm
            consultantId={consultantId}
            disabled={!setup.razorpayConfigured}
            makeDefault={setup.accounts.length > 0}
            onSaved={() => setChanging(false)}
          />
          {changing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setChanging(false)}
            >
              Keep the current account
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}

const ENTITY_LABEL: Record<string, string> = {
  INDIVIDUAL: "Individual",
  HUF: "Hindu undivided family",
  PARTNERSHIP: "Partnership",
  LLP: "LLP",
  COMPANY: "Company",
};

function TaxCard({
  consultantId,
  setup,
}: Readonly<{ consultantId: string; setup: PayoutSetup }>) {
  const { taxInfo } = setup;
  const [editing, setEditing] = useState(false);
  const hasPan = taxInfo.panMasked !== null;
  const badge = hasPan
    ? { label: "PAN on file", tone: "success" as const }
    : { label: "PAN missing", tone: "caution" as const };

  return (
    <SectionCard id="pan" icon={ReceiptText} title="Tax details" badge={badge}>
      {hasPan && !editing ? (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
            <div>
              <p className="font-medium">PAN {taxInfo.panMasked}</p>
              <p className="text-xs text-muted-foreground">
                {taxInfo.taxEntityType
                  ? ENTITY_LABEL[taxInfo.taxEntityType]
                  : "Entity type not declared"}
                {taxInfo.gstin ? ` · GSTIN ${taxInfo.gstin}` : ""}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              Change
            </Button>
          </div>
          <p id="gstin" className="scroll-mt-24 text-xs text-muted-foreground">
            {taxInfo.gstin
              ? "Your GSTIN is on file."
              : "If you are GST-registered, add your GSTIN; most consultants are below the threshold and can skip it."}
          </p>
        </div>
      ) : (
        <>
          {!hasPan && (
            <p className="mb-4 text-sm text-muted-foreground">
              Without a PAN the law makes us withhold more tax (Section 194-O).
            </p>
          )}
          <TaxInfoForm
            consultantId={consultantId}
            current={taxInfo}
            onSaved={() => setEditing(false)}
          />
          {editing && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          )}
        </>
      )}
    </SectionCard>
  );
}

export function GetPaidView({
  consultantId,
  setup,
}: Readonly<{ consultantId: string; setup: PayoutSetup }>) {
  const { requirements, eligibilityReason } = setup;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 text-base font-semibold">What we still need</h2>
        {eligibilityReason && (
          <p className="mb-3 text-sm text-muted-foreground">
            {REASON_LINE[eligibilityReason]}
          </p>
        )}
        <StepList
          currentlyDue={requirements.currentlyDue}
          eventuallyDue={requirements.eventuallyDue}
        />
      </section>
      <AccountCard consultantId={consultantId} setup={setup} />
      <TaxCard consultantId={consultantId} setup={setup} />
    </div>
  );
}

export function GetPaidClient({
  consultantId,
}: Readonly<{ consultantId: string }>) {
  const { data, isLoading, error } = useQuery({
    queryKey: payoutSetupQueryKey(consultantId),
    queryFn: fetchPayoutSetup,
    // Money-setup truth: always confirm the seed on mount.
    refetchOnMount: "always",
    staleTime: 0,
  });

  let body: React.ReactNode = null;
  if (isLoading && !data) {
    body = <SettingsSkeleton />;
  } else if (error && !data) {
    body = (
      <div className="mx-auto max-w-md rounded-lg bg-red-50 p-4 text-center text-sm text-red-600">
        {error.message || "Failed to load your payout setup."}
      </div>
    );
  } else if (data) {
    body = <GetPaidView consultantId={consultantId} setup={data} />;
  }

  return (
    <DashboardContent>
      <DashboardErrorBoundary>{body}</DashboardErrorBoundary>
    </DashboardContent>
  );
}
