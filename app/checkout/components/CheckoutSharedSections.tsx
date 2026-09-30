"use client";

import type { ReactNode } from "react";
import { Check, CreditCard as CreditCardIcon, Lock } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CompanyLogo } from "@/components/ui/company-logo";
import { Separator } from "@/components/ui/separator";
import { EmiHint } from "@/app/checkout/components/CheckoutFlags";
import { FxEstimateNote } from "@/app/checkout/components/FxEstimateNote";
import RazorpayCheckout from "@/app/checkout/components/RazorpayCheckout";
import StripeCheckout from "@/app/checkout/components/StripeCheckout";
import {
  formatPercentage,
  type PricingBreakdown,
} from "@/app/checkout/plans/math";
import { paymentGateways } from "@/app/checkout/plans/utils";
import type {
  CheckoutInput,
  SupportedCheckoutGateway,
} from "@/schemas/checkout";

export interface CheckoutErrorStateProps {
  error: string;
}

export function CheckoutErrorState({
  error,
}: Readonly<CheckoutErrorStateProps>) {
  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)] bg-muted/40 p-4">
      <div
        className="rounded-2xl border border-border bg-card p-8 shadow-elevation-2 text-card-foreground max-w-md w-full text-center"
        role="alert"
      >
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <svg
            className="h-6 w-6 text-destructive"
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
        <p className="font-semibold text-lg mb-2 text-foreground">
          Unable to load checkout
        </p>
        <p className="text-muted-foreground text-sm">{error}</p>
        <Button
          variant="outline"
          onClick={() => window.history.back()}
          className="mt-5"
        >
          Go back
        </Button>
      </div>
    </div>
  );
}

export interface CheckoutConsultantWorkExperience {
  company: string;
  companyDomain: string | null;
  isCurrent?: boolean;
}

export interface CheckoutConsultantHeaderProps {
  name?: string | null;
  image?: string | null;
  headline?: string | null;
  workExperiences?: ReadonlyArray<CheckoutConsultantWorkExperience> | null;
  planTypeLabel: string;
  planTitle: string;
}

export function CheckoutConsultantHeader({
  name,
  image,
  headline,
  workExperiences,
  planTypeLabel,
  planTitle,
}: Readonly<CheckoutConsultantHeaderProps>) {
  const displayName = name || "Consultant Name";
  const avatarAlt = name || "Consultant";
  const avatarInitial = name ? name.charAt(0) : "C";
  const displayHeadline = headline || "Consultant";

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-4 min-w-0">
        <Avatar className="w-12 h-12 border shrink-0">
          <AvatarImage
            src={image || "/placeholder-user.jpg"}
            alt={avatarAlt}
          />
          <AvatarFallback>{avatarInitial}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="font-semibold truncate">{displayName}</div>
          <div className="text-sm text-muted-foreground truncate">
            {displayHeadline}
          </div>
          {workExperiences && workExperiences.length > 0 && (
            <div className="flex items-center gap-1.5 mt-1">
              {workExperiences.slice(0, 3).map((exp) => (
                <CompanyLogo
                  key={`${exp.company}-${exp.companyDomain ?? "domain"}`}
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
        <div className="font-semibold">{planTypeLabel}</div>
        <div className="text-sm text-muted-foreground truncate">
          {planTitle}
        </div>
      </div>
    </div>
  );
}

export interface CheckoutPricingBreakdownProps {
  title: string;
  feeLabel: string;
  feeAmountPaise: number;
  includes: ReadonlyArray<string>;
  pricing: PricingBreakdown;
  formatPrice: (amount: number) => string;
  selectedOrganizationId: string | null;
  isLicenseCovered?: boolean;
  afterTotalNotice?: ReactNode;
}

export function CheckoutPricingBreakdown({
  title,
  feeLabel,
  feeAmountPaise,
  includes,
  pricing,
  formatPrice,
  selectedOrganizationId,
  isLicenseCovered = false,
  afterTotalNotice,
}: Readonly<CheckoutPricingBreakdownProps>) {
  const displayedTotal = isLicenseCovered
    ? formatPrice(0)
    : formatPrice(pricing.total);

  return (
    <Card className="rounded-2xl border-border shadow-elevation-1">
      <CardHeader>
        <CardTitle className="text-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3">
          <div className="flex items-center justify-between">
            <div className="text-muted-foreground">{feeLabel}</div>
            <div className="font-medium">{formatPrice(feeAmountPaise)}</div>
          </div>
          <Separator className="bg-border" />
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Includes
            </div>
            <ul className="space-y-1.5 text-sm text-foreground">
              {includes.map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <Separator className="bg-border" />
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <div>Subtotal</div>
            <div>{formatPrice(pricing.subtotal)}</div>
          </div>
          <div className="flex items-center justify-between">
            <div>Tax ({formatPercentage(pricing.taxRate)})</div>
            <div>{formatPrice(pricing.taxAmount)}</div>
          </div>
          {pricing.discountAmount > 0 && (
            <div className="flex items-center justify-between text-green-600">
              <div>
                Discount{" "}
                {pricing.discountPercent > 0 &&
                  `(${formatPercentage(pricing.discountPercent)})`}
              </div>
              <div>-{formatPrice(pricing.discountAmount)}</div>
            </div>
          )}
          {pricing.creditsApplied > 0 && (
            <div className="flex items-center justify-between text-foreground">
              <div>Referral Credits</div>
              <div>-{formatPrice(pricing.creditsApplied)}</div>
            </div>
          )}
          <Separator className="bg-border" />
          <div className="flex items-center justify-between font-semibold">
            <div>Total</div>
            <div>{displayedTotal}</div>
          </div>
          {afterTotalNotice}
          {!isLicenseCovered && (
            <FxEstimateNote
              totalPaise={pricing.total}
              organizationId={selectedOrganizationId}
            />
          )}
          {!isLicenseCovered && (
            <EmiHint
              totalPaise={pricing.total}
              organizationId={selectedOrganizationId}
            />
          )}
          {isLicenseCovered && (
            <p className="text-xs text-emerald-600">
              Session value {formatPrice(pricing.total)} — covered by
              enterprise license
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export interface CheckoutPaymentMethodsCardProps {
  buildCheckoutData: (
    gateway: SupportedCheckoutGateway,
  ) => CheckoutInput | null;
  onRazorpaySuccess: (response: {
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    message?: string;
  }) => void;
  onRazorpayError: (error: {
    description?: string;
    code?: string;
    reason?: string;
    message?: string;
  }) => void;
  onStripeSuccess: (response: { message: string }) => void;
  onStripeError: (error: {
    message?: string;
    code?: string;
    errorType?: string;
    error?: string;
    description?: string;
  }) => void;
  onMockPay: (gateway: SupportedCheckoutGateway) => void;
  isCheckoutProcessing: boolean;
  processingGateway: string | null;
  isMaintenanceBlocked: boolean;
  isSoldOut?: boolean;
  onBeforeCheckout?: () => Promise<boolean>;
}

export function CheckoutPaymentMethodsCard({
  buildCheckoutData,
  onRazorpaySuccess,
  onRazorpayError,
  onStripeSuccess,
  onStripeError,
  onMockPay,
  isCheckoutProcessing,
  processingGateway,
  isMaintenanceBlocked,
  isSoldOut = false,
  onBeforeCheckout,
}: Readonly<CheckoutPaymentMethodsCardProps>) {
  const renderGatewayCheckout = (
    gateway: SupportedCheckoutGateway,
  ): ReactNode => {
    const checkoutData = buildCheckoutData(gateway);
    if (!checkoutData) {
      return null;
    }

    if (gateway === "RAZORPAY") {
      return (
        <RazorpayCheckout
          checkoutData={checkoutData}
          onPaymentSuccess={onRazorpaySuccess}
          onPaymentError={onRazorpayError}
          onBeforeCheckout={onBeforeCheckout}
          disabled={isMaintenanceBlocked || isSoldOut}
        />
      );
    }

    return (
      <StripeCheckout
        checkoutData={checkoutData}
        onPaymentSuccess={onStripeSuccess}
        onPaymentError={onStripeError}
        onBeforeCheckout={onBeforeCheckout}
        disabled={isMaintenanceBlocked || isSoldOut}
      />
    );
  };

  const renderGatewayAction = (
    gateway: (typeof paymentGateways)[number],
  ): ReactNode => {
    if (isSoldOut) {
      return (
        <Button variant="outline" disabled>
          Sold out
        </Button>
      );
    }

    if (!gateway.isActive) {
      return (
        <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
          Coming Soon
        </span>
      );
    }

    const isMockSpinning =
      isCheckoutProcessing && processingGateway === `${gateway.gateway}-mock`;

    return (
      <div className="flex gap-2">
        {renderGatewayCheckout(gateway.gateway)}
        {process.env.NODE_ENV === "development" && (
          <Button
            variant="secondary"
            onClick={() => onMockPay(gateway.gateway)}
            disabled={isCheckoutProcessing || isMaintenanceBlocked}
          >
            {isMockSpinning ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-t-2 border-b-2 border-current mr-2" />
                Processing...
              </>
            ) : (
              `Mock Pay (${gateway.name})`
            )}
          </Button>
        )}
      </div>
    );
  };

  return (
    <Card className="rounded-2xl border-border shadow-elevation-1">
      <CardHeader className="pb-3">
        <CardTitle className="text-base text-foreground">
          Payment Method
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Select your preferred payment method
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="divide-y divide-border">
          {paymentGateways.map((gateway) => (
            <div
              key={gateway.gateway}
              className="flex flex-wrap items-center justify-between gap-4 py-3.5 first:pt-0 last:pb-0"
            >
              <div className="flex items-center gap-3.5 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50">
                  <CreditCardIcon className="w-5 h-5 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-foreground">
                    {gateway.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {gateway.description}
                  </div>
                </div>
              </div>
              {renderGatewayAction(gateway)}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span>
            256-bit SSL encrypted checkout. Additional international gateways
            coming soon.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
