"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { formatCurrencyAmount } from "@/utils/formatting";
import { type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { CreditCard as CreditCardIcon } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyLogo } from "@/components/ui/company-logo";
import { Separator } from "@/components/ui/separator";
import { GroupSessionDisclosure } from "@/components/booking/GroupSessionDisclosure";
import type { PurchaseFunding } from "@/components/booking/CancellationPolicyNote";
import { CheckoutPlanSkeleton } from "@/app/checkout/CheckoutSkeletons";
import { OrgPayerSelector } from "@/app/checkout/components/OrgPayerSelector";
import RazorpayCheckout from "@/app/checkout/components/RazorpayCheckout";
import {
  ReferralCreditsBlock,
  useReferralCreditsBalance,
} from "@/app/checkout/components/referral-credits";
import {
  BillingStateSelect,
  useBillingState,
} from "@/app/checkout/components/BillingStateSelect";
import { useMaintenanceGuard } from "@/hooks/useMaintenanceGuard";
import { useToast } from "@/hooks/use-toast";
import { useCurrency } from "@/hooks/useCurrency";
import { fetchWithIdentity } from "@/lib/auth/identity-header";
import {
  checkoutResponseSchema,
  createCheckoutData,
  type CheckoutInput,
  type SupportedCheckoutGateway,
} from "@/schemas/checkout";

import {
  formatPercentage,
  calculatePricing,
  type PricingBreakdown,
} from "../math";
import { useHandleApiError } from "../use-handle-api-error";
import { useCheckoutTaxContext } from "../useCheckoutTaxContext";
import { useReferralPricing } from "../useReferralPricing";
import { useOwnOpenOrderCredits } from "../useOwnOpenOrderCredits";
import {
  busyRetryToast,
  createHandleCheckoutSuccess,
  createRazorpayCheckoutHandlers,
  fetchCheckoutWithBusyRetry,
  handleUnifiedCheckout,
  paymentGateways,
  reportPaymentsError,
  useCheckoutAttemptKey,
  type CheckoutApiError,
} from "../utils";
import { CheckoutTotals } from "./CheckoutTotals";
import {
  DiscountCodeField,
  isDiscountRefusal,
  useDiscountCode,
} from "./DiscountCodeField";

export type CheckoutSearchParams = Record<
  string,
  string | string[] | undefined
>;

/** The plan-specific half of a checkout body; the shell adds who pays and how. */
export type CheckoutPlanFields = Omit<
  Parameters<typeof createCheckoutData>[0],
  | "paymentGateway"
  | "discountCode"
  | "displayCurrency"
  | "useReferralCredits"
  | "organizationId"
  | "consumerStateCode"
>;

export interface CheckoutHeaderUser {
  name?: string | null;
  image?: string | null;
  workExperiences?: Array<{
    company: string;
    companyDomain: string | null;
    isCurrent: boolean;
  }>;
}

export interface FooterContext {
  pricing: PricingBreakdown;
  taxContext: ReturnType<typeof useCheckoutTaxContext>;
  formatPrice: (paise: number) => string;
  purchaseFunding: PurchaseFunding;
  selectedOrganizationId: string | null;
}

/** How the dev-only Mock Pay button completes an order for one plan type. */
export type MockFlow =
  | { kind: "unified"; type: "WEBINAR" | "CLASS" }
  | {
      kind: "direct";
      successTitle: string;
      confirmation: (data: {
        isZeroAmountPayment?: boolean;
        isMockPayment?: boolean;
      }) => string;
    };

export interface CheckoutErrorRecovery {
  title: string;
  label: string;
  href: string;
}

/**
 * Everything that differs between the four plan checkouts. Each plan type
 * supplies one adapter hook; the shell owns discount, credits, payer, billing
 * state, the totals and the payment controls.
 */
export interface CheckoutPlanAdapter {
  appointmentType: "WEBINAR" | "CLASS" | "CONSULTATION" | "SUBSCRIPTION";
  isLoading: boolean;
  /** A load or staleness error shown in place of the page. */
  error: string | null;
  /** Replaces the error view's "Go back" with one action, e.g. back to the plan's grid. */
  errorRecovery?: CheckoutErrorRecovery | null;
  /** Set when the loaded plan is incomplete; shown in place of the page. */
  missingMessage: string | null;
  consultantProfileId: string | undefined;
  header: {
    user: CheckoutHeaderUser | undefined;
    headline: string;
    typeLabel: string;
    title: string;
  };
  detailsTitle: string;
  detailsBanner?: ReactNode;
  detailRows: ReactNode;
  /** Group sessions disclose that other attendees share the room. */
  groupDisclosure: boolean;
  basePricePaise: number;
  pricingTitle: string;
  feeLabel: string;
  /** Only what the plan states; an empty list hides the row. */
  includes: string[];
  renderFooter: (ctx: FooterContext) => ReactNode;
  /** Null hides the Razorpay button (nothing to buy yet). */
  checkoutPlanFields: CheckoutPlanFields | null;
  soldOut: boolean;
  /** The disabled pay button's label when `soldOut`; event seats read "Sold out". */
  soldOutLabel?: string;
  /** Runs after billing-state validation; false stops the payment. */
  beforePay?: () => Promise<boolean> | boolean;
  /** A refusal only this plan type handles; true when it did. */
  onCheckoutRefusal?: (errorData: CheckoutApiError) => boolean;
  /** Gateway-reported failures go through the refusal handler, not the card-decline wording. */
  paymentErrorsAsRefusals?: boolean;
  mockFlow: MockFlow;
  /** Throws a user-facing Error when the mock order cannot be built. */
  preflight?: () => void;
  describeMockError?: (error: Error) => { title: string; description: string };
}

/** One label and value line of the details or pricing card. */
export function CheckoutDetailRow({
  label,
  children,
  className,
}: Readonly<{ label: string; children: ReactNode; className?: string }>) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-muted-foreground">{label}</div>
      <div className={className}>{children}</div>
    </div>
  );
}

const LOAD_ERROR_BUTTON =
  "mt-5 inline-flex min-h-11 items-center rounded-lg bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors";

function LoadError({
  message,
  recovery,
}: Readonly<{ message: string; recovery: CheckoutErrorRecovery | null }>) {
  return (
    <div className="col-span-full flex items-center justify-center min-h-screen bg-muted">
      <div
        className="bg-foreground border border-border text-background p-8 max-w-md w-full mx-4 text-center rounded-xl shadow-xl"
        role="alert"
      >
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-background/10">
          <svg
            className="h-6 w-6 text-background/70"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
            />
          </svg>
        </div>
        <p className="font-semibold text-lg mb-2">
          {recovery?.title ?? "Unable to load checkout"}
        </p>
        <p className="text-background/70 text-sm">{message}</p>
        {recovery ? (
          <Link href={recovery.href} className={LOAD_ERROR_BUTTON}>
            {recovery.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => window.history.back()}
            className={LOAD_ERROR_BUTTON}
          >
            Go back
          </button>
        )}
      </div>
    </div>
  );
}

function CheckoutHeader({
  header,
}: Readonly<{ header: CheckoutPlanAdapter["header"] }>) {
  const { user } = header;
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-4 min-w-0">
        <Avatar className="w-12 h-12 border shrink-0">
          <AvatarImage
            src={user?.image || "/placeholder-user.jpg"}
            alt={user?.name || "Consultant"}
          />
          <AvatarFallback>
            {user?.name ? user.name.charAt(0) : "C"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="font-semibold truncate">
            {user?.name || "Consultant Name"}
          </div>
          <div className="text-sm text-muted-foreground truncate">
            {header.headline}
          </div>
          {user?.workExperiences && user.workExperiences.length > 0 && (
            <div className="flex items-center gap-1.5 mt-1">
              {user.workExperiences.slice(0, 3).map((exp, i) => (
                <CompanyLogo
                  key={`checkout-company-${i}`}
                  companyName={exp.company}
                  companyDomain={exp.companyDomain ?? undefined}
                  size={20}
                  className="border-border"
                />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="text-right min-w-0">
        <div className="font-semibold">{header.typeLabel}</div>
        <div className="text-sm text-muted-foreground truncate">
          {header.title}
        </div>
      </div>
    </div>
  );
}

function PaymentGatewayCards({
  adapter,
  razorpay,
  isCheckoutProcessing,
  processingGateway,
  isMaintenanceBlocked,
  onMockPay,
}: Readonly<{
  adapter: CheckoutPlanAdapter;
  razorpay: ReactNode;
  isCheckoutProcessing: boolean;
  processingGateway: string | null;
  isMaintenanceBlocked: boolean;
  onMockPay: (gateway: SupportedCheckoutGateway) => void;
}>) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <div className="font-semibold">Payment</div>
        <div className="text-muted-foreground">
          Select your preferred payment method
        </div>
      </div>
      {paymentGateways.map((gateway) => (
        <Card key={gateway.gateway} className="border-border">
          <CardHeader>
            <CardTitle className="text-foreground">{gateway.name}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <CreditCardIcon className="w-8 h-8 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <div className="font-semibold text-foreground">
                    Credit/Debit Card
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {gateway.description}
                  </div>
                </div>
              </div>
              {adapter.soldOut ? (
                <Button variant="outline" disabled>
                  {adapter.soldOutLabel ?? "Sold out"}
                </Button>
              ) : gateway.isActive ? (
                <div className="flex gap-2">
                  {gateway.gateway === "RAZORPAY" ? razorpay : null}
                  {process.env.NODE_ENV === "development" && (
                    <Button
                      variant="secondary"
                      onClick={() => onMockPay(gateway.gateway)}
                      disabled={isCheckoutProcessing || isMaintenanceBlocked}
                    >
                      {isCheckoutProcessing &&
                      processingGateway === `${gateway.gateway}-mock` ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-current mr-2"></div>
                          Processing...
                        </>
                      ) : (
                        `Mock Pay (${gateway.name})`
                      )}
                    </Button>
                  )}
                </div>
              ) : (
                <Button variant="outline" disabled>
                  Coming Soon
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * The checkout every plan type shares: payer, billing state, discount code,
 * referral credits, the price breakdown and the payment controls.
 */
export function PlanCheckoutShell({
  useAdapter,
  planId,
  searchParams,
}: Readonly<{
  useAdapter: (
    planId: string,
    searchParams: CheckoutSearchParams,
  ) => CheckoutPlanAdapter;
  planId: string;
  searchParams: CheckoutSearchParams;
}>) {
  const router = useRouter();
  const { formatPriceExact, currency } = useCurrency();
  const checkoutTaxContext = useCheckoutTaxContext();
  const {
    availableCredits: baseAvailableCredits,
    isLoadingCredits: isLoadingBaseCredits,
    creditsLoadFailed: baseCreditsLoadFailed,
  } = useReferralCreditsBalance(
    checkoutTaxContext.referralCreditsLoaded,
    checkoutTaxContext.referralCreditsPaise,
  );
  const adapter = useAdapter(planId, searchParams);
  const queryClient = useQueryClient();
  const referralPricing = useReferralPricing(adapter.consultantProfileId);

  const [isCheckoutProcessing, setIsCheckoutProcessing] = useState(false);
  const attemptKey = useCheckoutAttemptKey();
  const isProcessingRef = useRef(false);
  const [processingGateway, setProcessingGateway] = useState<string | null>(
    null,
  );
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<
    string | null
  >(null);
  // The item this page buys, so its own open order's credit and code count as the buyer's.
  const openOrderItem = useMemo(
    () =>
      adapter.checkoutPlanFields
        ? createCheckoutData({
            ...adapter.checkoutPlanFields,
            paymentGateway: "RAZORPAY",
            organizationId: selectedOrganizationId ?? undefined,
          })
        : null,
    [adapter.checkoutPlanFields, selectedOrganizationId],
  );
  const held = useOwnOpenOrderCredits(openOrderItem);
  const availableCredits = baseAvailableCredits + held.heldCredits;
  const isLoadingCredits = isLoadingBaseCredits || held.isLoading;
  const creditsLoadFailed = baseCreditsLoadFailed || held.loadFailed;
  const discount = useDiscountCode({
    amountPaise: adapter.basePricePaise,
    consultantProfileId: adapter.consultantProfileId,
    checkout: openOrderItem,
  });
  const appliedDiscount = discount.applied;
  const [useReferralCredits, setUseReferralCredits] = useState(false);
  const billingState = useBillingState(
    checkoutTaxContext,
    selectedOrganizationId,
  );
  const { validate: validateBillingState } = billingState;

  // Derived from the buyer's own funding choices, so the refund-rail promise
  // under the price moves the moment they change how they pay.
  const purchaseFunding: PurchaseFunding = selectedOrganizationId
    ? { kind: "organization", name: null }
    : useReferralCredits
      ? { kind: "credits" }
      : { kind: "gateway" };

  const { toast } = useToast();
  const {
    isBlocked: isMaintenanceBlocked,
    blockReason: maintenanceBlockReason,
  } = useMaintenanceGuard();

  const baseHandleApiError = useHandleApiError(toast);
  const { refuse: refuseDiscount } = discount;
  // A refused discount code is a field problem, shown in the field; everything
  // else is a toast.
  const handleApiError = useCallback(
    (errorData: CheckoutApiError) => {
      if (isDiscountRefusal(errorData)) {
        refuseDiscount(
          errorData.error ??
            "That discount code can't be used on this booking.",
          appliedDiscount?.code,
        );
        return;
      }
      if (adapter.onCheckoutRefusal?.(errorData)) return;
      baseHandleApiError(errorData);
    },
    [adapter, appliedDiscount?.code, baseHandleApiError, refuseDiscount],
  );

  const razorpayHandlers = useMemo(
    () => createRazorpayCheckoutHandlers(toast),
    [toast],
  );
  const { paymentErrorsAsRefusals } = adapter;
  const onPaymentError = useCallback(
    (error: Parameters<typeof razorpayHandlers.onPaymentError>[0]) => {
      if (isDiscountRefusal({ code: error.code })) {
        refuseDiscount(
          error.description ??
            error.message ??
            "That discount code can't be used on this booking.",
          appliedDiscount?.code,
        );
        return;
      }
      if (paymentErrorsAsRefusals) {
        // The same string arrives as `code` on the body and titles a typed refusal.
        handleApiError({
          error: error.description ?? error.message ?? error.reason,
          errorType: error.errorType ?? error.code,
          code: error.code,
        });
        return;
      }
      razorpayHandlers.onPaymentError(error);
    },
    [
      appliedDiscount?.code,
      handleApiError,
      paymentErrorsAsRefusals,
      razorpayHandlers,
      refuseDiscount,
    ],
  );

  // Calculate pricing before any early return to keep hook order stable.
  const pricing = useMemo(() => {
    let discountPercent = 0;
    let discountAmount = 0;
    if (appliedDiscount) {
      // The preview's own amount already includes the maxDiscount cap and the
      // profitability floor.
      if (appliedDiscount.discountAmount !== undefined) {
        discountAmount = appliedDiscount.discountAmount;
      } else if (appliedDiscount.discountType === "PERCENTAGE") {
        discountPercent = appliedDiscount.discountValue / 100;
      } else if (appliedDiscount.discountType === "FIXED_AMOUNT") {
        discountAmount = appliedDiscount.discountValue;
      }
    }
    return calculatePricing(adapter.basePricePaise, {
      discountPercent: discountAmount > 0 ? 0 : discountPercent,
      discountAmount,
      creditsApplied: useReferralCredits ? availableCredits : 0,
      welcomeDiscount:
        appliedDiscount || selectedOrganizationId
          ? null
          : referralPricing?.welcomeDiscount,
      creditCapBps: referralPricing?.creditCapBps,
      promoFeeBps: referralPricing?.promoFeeBps,
      isInternational: checkoutTaxContext.isInternational,
      exportZeroRated: checkoutTaxContext.exportZeroRated,
      gstRegistered: checkoutTaxContext.gstRegistered,
    });
  }, [
    referralPricing,
    selectedOrganizationId,
    adapter.basePricePaise,
    appliedDiscount,
    useReferralCredits,
    availableCredits,
    checkoutTaxContext.isInternational,
    checkoutTaxContext.exportZeroRated,
    checkoutTaxContext.gstRegistered,
  ]);

  // The server's price when it answered a free-looking order with a payment.
  const [priceChange, setPriceChange] = useState<{
    amount: number;
    currency: string;
  } | null>(null);
  // Nothing to pay and no credit spent: one confirm button, no payer, method or refund copy.
  const isFree =
    pricing.total === 0 && pricing.creditsApplied === 0 && priceChange === null;
  // A free order is the buyer's own: a payer picked before the price fell to zero is cleared.
  if (isFree && selectedOrganizationId) setSelectedOrganizationId(null);

  const buildCheckoutData = useCallback(
    (gateway: SupportedCheckoutGateway): CheckoutInput | null => {
      if (!adapter.checkoutPlanFields) return null;
      return createCheckoutData({
        ...adapter.checkoutPlanFields,
        paymentGateway: gateway,
        discountCode: appliedDiscount?.code,
        displayCurrency: currency,
        useReferralCredits:
          isFree || selectedOrganizationId ? false : useReferralCredits,
        organizationId: isFree
          ? undefined
          : (selectedOrganizationId ?? undefined),
        ...(isFree ? {} : billingState.bodyField),
      });
    },
    [
      adapter.checkoutPlanFields,
      appliedDiscount?.code,
      currency,
      isFree,
      selectedOrganizationId,
      useReferralCredits,
      billingState.bodyField,
    ],
  );

  const handleMockCheckout = useCallback(
    async (gateway: SupportedCheckoutGateway) => {
      if (isMaintenanceBlocked) {
        toast({
          title: "Checkout unavailable",
          description:
            maintenanceBlockReason ?? "Service temporarily unavailable",
          variant: "destructive",
        });
        return;
      }
      if (!validateBillingState()) return;
      // The ref is the synchronous double-click guard; React state is async.
      if (isProcessingRef.current || isCheckoutProcessing) return;
      isProcessingRef.current = true;

      try {
        setIsCheckoutProcessing(true);
        setProcessingGateway(`${gateway}-mock`);
        adapter.preflight?.();
        const checkoutData = buildCheckoutData(gateway);
        if (!checkoutData) throw new Error("Nothing to check out yet");

        const flow = adapter.mockFlow;
        if (flow.kind === "unified") {
          await handleUnifiedCheckout(
            checkoutData,
            gateway,
            handleApiError,
            createHandleCheckoutSuccess(toast, flow.type),
            true,
          );
          return;
        }

        // Structured BUSY 409s auto-retry; the idempotency key keeps that dedupe-safe.
        const response = await fetchCheckoutWithBusyRetry(
          () =>
            fetchWithIdentity("/api/checkout", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...checkoutData,
                isMockPayment: true,
                clientIdempotencyKey: attemptKey(checkoutData),
              }),
            }),
          (waitSeconds) => toast(busyRetryToast(waitSeconds)),
        );
        if (!response.ok) {
          handleApiError(await response.json());
          return;
        }
        const data = await response.json();
        if (!checkoutResponseSchema.safeParse(data).success) {
          throw new Error("Invalid response format from server");
        }
        if (!data.success) {
          handleApiError({ error: data.error, errorType: data.errorType });
          return;
        }
        if (
          data.skipPayment ||
          data.isMockPayment ||
          data.isZeroAmountPayment
        ) {
          toast({
            title: flow.successTitle,
            description: flow.confirmation(data),
            variant: "default",
          });
          setTimeout(() => router.push("/dashboard"), 2000);
        }
      } catch (error) {
        reportPaymentsError(error);
        console.error("Checkout error:", error);
        const copy =
          error instanceof Error
            ? (adapter.describeMockError?.(error) ?? {
                title: "Checkout Failed",
                description: error.message,
              })
            : { title: "Checkout Failed", description: "Please try again" };
        toast({ ...copy, variant: "destructive" });
      } finally {
        isProcessingRef.current = false;
        setIsCheckoutProcessing(false);
        setProcessingGateway(null);
      }
    },
    [
      adapter,
      attemptKey,
      buildCheckoutData,
      handleApiError,
      isCheckoutProcessing,
      isMaintenanceBlocked,
      maintenanceBlockReason,
      router,
      toast,
      validateBillingState,
    ],
  );

  // Always declared, even when it will not render, so hook order is stable.
  const razorpayData = buildCheckoutData("RAZORPAY");
  const { beforePay } = adapter;
  const onBeforeCheckout = useCallback(async () => {
    if (!isFree && !validateBillingState()) return false;
    return beforePay ? await beforePay() : true;
  }, [isFree, validateBillingState, beforePay]);

  if (adapter.isLoading) return <CheckoutPlanSkeleton />;
  if (adapter.error) {
    return (
      <LoadError
        message={adapter.error}
        recovery={adapter.errorRecovery ?? null}
      />
    );
  }
  if (adapter.missingMessage) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p>{adapter.missingMessage}</p>
      </div>
    );
  }

  const footerCtx: FooterContext = {
    pricing,
    taxContext: checkoutTaxContext,
    formatPrice: formatPriceExact,
    purchaseFunding,
    selectedOrganizationId,
  };

  return (
    <>
      <div className="flex min-w-0 flex-col gap-6 border-r border-border bg-gradient-to-br from-muted via-background to-muted p-6 sm:p-8">
        <CheckoutHeader header={adapter.header} />
        <Separator className="bg-border" />
        <div className="grid gap-2">
          <div className="font-semibold">{adapter.detailsTitle}</div>
          {adapter.detailsBanner}
          <div className="grid gap-2">{adapter.detailRows}</div>
        </div>
        {/* Shown before anyone picks who pays. */}
        {adapter.groupDisclosure && <GroupSessionDisclosure />}
        {!isFree && (
          <>
            <Separator className="bg-border" />
            <OrgPayerSelector
              selectedOrganizationId={selectedOrganizationId}
              planType={adapter.appointmentType}
              planId={planId}
              onSelect={(id) => {
                setSelectedOrganizationId(id);
                // An organisation payer forces referral credits off.
                if (id) setUseReferralCredits(false);
              }}
            />
            <Separator className="bg-border" />
            <BillingStateSelect {...billingState.selectProps} />
          </>
        )}
        <Separator className="bg-border" />
        <DiscountCodeField
          discount={discount}
          formatPrice={formatPriceExact}
          listPricePaise={adapter.basePricePaise}
        />
        {!isFree && (
          <>
            <Separator className="bg-border" />
            <ReferralCreditsBlock
              availableCredits={availableCredits}
              isLoadingCredits={isLoadingCredits}
              creditsLoadFailed={creditsLoadFailed}
              useReferralCredits={useReferralCredits}
              onCheckedChange={setUseReferralCredits}
              formatPrice={formatPriceExact}
            />
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-8 p-6 sm:p-8 bg-card">
        <Card className="border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-foreground">
              {adapter.pricingTitle}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>{adapter.feeLabel}</div>
                <div>{formatPriceExact(adapter.basePricePaise)}</div>
              </div>
              {adapter.includes.length > 0 && (
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <span className="font-semibold">Includes</span>
                  </div>
                  <div className="font-semibold">
                    <ul className="list-disc">
                      {adapter.includes.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
            <Separator className="bg-border" />
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <div>Subtotal</div>
                <div>{formatPriceExact(pricing.subtotal)}</div>
              </div>
              {pricing.discountAmount > 0 && (
                <div className="flex items-center justify-between text-green-600">
                  <div>
                    {appliedDiscount ? "Discount" : "Welcome discount"}{" "}
                    {pricing.discountPercent > 0 &&
                      `(${formatPercentage(pricing.discountPercent)})`}
                  </div>
                  <div>-{formatPriceExact(pricing.discountAmount)}</div>
                </div>
              )}
              {priceChange && (
                <p
                  role="status"
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                >
                  The price changed to{" "}
                  {formatCurrencyAmount(
                    priceChange.amount,
                    priceChange.currency,
                  )}
                  .
                </p>
              )}
              <CheckoutTotals
                pricing={pricing}
                formatPrice={formatPriceExact}
                taxContext={checkoutTaxContext}
              />
              {!isFree && adapter.renderFooter(footerCtx)}
            </div>
          </CardContent>
        </Card>
        {isFree ? (
          <div className="flex justify-end">
            {adapter.soldOut ? (
              <Button variant="outline" disabled>
                {adapter.soldOutLabel ?? "Sold out"}
              </Button>
            ) : razorpayData ? (
              <RazorpayCheckout
                checkoutData={razorpayData}
                onPaymentSuccess={razorpayHandlers.onPaymentSuccess}
                onPaymentError={onPaymentError}
                onBeforeCheckout={onBeforeCheckout}
                disabled={isMaintenanceBlocked}
                label="Confirm booking"
                onPaidWhenFree={(order) => {
                  // Nothing opens: the buyer reads the new price and presses again.
                  setPriceChange(order);
                  void queryClient.invalidateQueries({
                    queryKey: ["checkout-plan", planId],
                  });
                }}
              />
            ) : null}
          </div>
        ) : (
          <PaymentGatewayCards
            adapter={adapter}
            isCheckoutProcessing={isCheckoutProcessing}
            processingGateway={processingGateway}
            isMaintenanceBlocked={isMaintenanceBlocked}
            onMockPay={(gateway) => void handleMockCheckout(gateway)}
            razorpay={
              razorpayData ? (
                <RazorpayCheckout
                  checkoutData={razorpayData}
                  onPaymentSuccess={razorpayHandlers.onPaymentSuccess}
                  onPaymentError={onPaymentError}
                  onBeforeCheckout={onBeforeCheckout}
                  disabled={isMaintenanceBlocked || adapter.soldOut}
                />
              ) : null
            }
          />
        )}
      </div>
    </>
  );
}
