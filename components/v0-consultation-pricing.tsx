"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { TConsultantProfile } from "@/types/consultant"
import { ConsultationPlan, SubscriptionPlan } from "@prisma/client"

type PlanType = "consultation" | "subscription"

type Option = {
  label: string
  value: string
  price: number
  badge?: "Most Popular" | "Best Value"
  unit: "/hour" | "/month"
  plan: ConsultationPlan | SubscriptionPlan
}

const FEATURES: Record<PlanType, string[]> = {
  consultation: ["✓ Document verification", "✓ 1 on 1 call", "✓ Actionable next steps", "✓ Follow-up recap email"],
  subscription: [
    "✓ Weekly 1 on 1 check-ins",
    "✓ Unlimited email Q&A",
    "✓ Priority support",
    "✓ Resource library access",
  ],
}

interface V0ConsultationPricingProps {
  className?: string
  consultantDetails: TConsultantProfile
  onConsultationBook: (plan: ConsultationPlan) => void
  onSubscriptionBook: (plan: SubscriptionPlan) => void
}

export function V0ConsultationPricing({
  className,
  consultantDetails,
  onConsultationBook,
  onSubscriptionBook,
}: V0ConsultationPricingProps) {
  // Create options from consultant's plans
  const consultationOptions: Option[] = React.useMemo(() => {
    return consultantDetails.consultationPlans
      .sort((a, b) => a.durationInHours - b.durationInHours)
      .map((plan, index) => ({
        label: `${plan.durationInHours} Hour${plan.durationInHours > 1 ? 's' : ''}`,
        value: `${plan.durationInHours}h`,
        price: plan.price,
        badge: index === 1 ? "Most Popular" : undefined,
        unit: "/hour" as const,
        plan,
      }))
  }, [consultantDetails.consultationPlans])

  const subscriptionOptions: Option[] = React.useMemo(() => {
    return consultantDetails.subscriptionPlans
      .sort((a, b) => a.durationInMonths - b.durationInMonths)
      .map((plan, index) => ({
        label: `${plan.durationInMonths} Month${plan.durationInMonths > 1 ? 's' : ''}`,
        value: `${plan.durationInMonths}m`,
        price: plan.price,
        badge: index === 1 ? "Most Popular" : index === 2 ? "Best Value" : undefined,
        unit: "/month" as const,
        plan,
      }))
  }, [consultantDetails.subscriptionPlans])

  const [plan, setPlan] = React.useState<PlanType>(
    consultationOptions.length > 0 ? "consultation" : "subscription"
  )
  const [selected, setSelected] = React.useState<string>(
    consultationOptions.length > 1 ? consultationOptions[1].value : consultationOptions[0]?.value || subscriptionOptions[0]?.value
  )

  const OPTIONS = React.useMemo(() => ({
    consultation: consultationOptions,
    subscription: subscriptionOptions,
  }), [consultationOptions, subscriptionOptions])

  React.useEffect(() => {
    // When switching tabs, pick sensible default
    const nextDefault = plan === "consultation"
      ? (OPTIONS.consultation[1]?.value || OPTIONS.consultation[0]?.value)
      : (OPTIONS.subscription[1]?.value || OPTIONS.subscription[0]?.value)
    setSelected(nextDefault)
  }, [plan, OPTIONS])

  const activeOption = React.useMemo(() => {
    return OPTIONS[plan].find((o) => o.value === selected) ?? OPTIONS[plan][0]
  }, [plan, selected, OPTIONS])

  const handleBookNow = () => {
    if (!activeOption) return

    if (plan === "consultation") {
      onConsultationBook(activeOption.plan as ConsultationPlan)
    } else {
      onSubscriptionBook(activeOption.plan as SubscriptionPlan)
    }
  }

  return (
    <section
      className={cn("w-full", "max-w-[64rem] mx-auto p-6 md:p-8", className)}
      aria-label="Consultation Pricing"
    >
      <header className="text-center mb-8 md:mb-10">
        <div className="mb-3">
          <h1 className="text-pretty text-3xl md:text-4xl font-bold tracking-tight text-white">Consultation Pricing</h1>
          <div className="h-1 w-24 mx-auto mt-3 bg-gradient-to-r from-white to-gray-600 rounded-full"></div>
        </div>
        <p className="text-base md:text-lg text-gray-300 mt-4">
          Choose between one-off consultation or ongoing subscription.
        </p>
      </header>

      {/* Tabs / Segmented Control - Dark Theme */}
      <div
        role="tablist"
        aria-label="Pricing type"
        className={cn(
          "relative mx-auto w-full max-w-sm",
          "rounded-xl bg-gradient-to-br from-gray-800/90 to-gray-900/90 p-1.5 border border-gray-700/50 shadow-lg backdrop-blur-sm"
        )}
      >
        <div className="grid grid-cols-2 gap-1.5">
          {consultationOptions.length > 0 && (
            <SegmentedTrigger isActive={plan === "consultation"} onClick={() => setPlan("consultation")}>
              Consultation
            </SegmentedTrigger>
          )}
          {subscriptionOptions.length > 0 && (
            <SegmentedTrigger isActive={plan === "subscription"} onClick={() => setPlan("subscription")}>
              Subscription
            </SegmentedTrigger>
          )}
        </div>
      </div>

      {/* Card - Dark Theme */}
      <div
        className={cn(
          "relative mt-8 md:mt-10",
          "rounded-2xl border border-gray-700/50",
          "bg-gradient-to-br from-gray-900/95 to-gray-800/95 backdrop-blur-md",
          "shadow-2xl shadow-gray-900/50",
          "animate-in fade-in-50 slide-in-from-bottom-2",
        )}
      >
        {/* Elegant top border accent */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-white/80 via-gray-400 to-white/80"></div>

        {/* Shimmer effect */}
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 pointer-events-none"></div>

        {/* Badge if applicable */}
        {activeOption?.badge && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <span
              className={cn(
                "inline-flex items-center rounded-full px-4 py-1.5 text-sm font-medium",
                "border border-gray-600/50 bg-gray-800/90 text-white",
                "shadow-lg backdrop-blur",
              )}
            >
              {activeOption.badge}
            </span>
          </div>
        )}

        <div className="p-6 md:p-10 grid gap-8 md:gap-10">
          {/* Option Pills */}
          {OPTIONS[plan].length > 1 && (
            <div>
              <h2 className="sr-only">Timeframe options</h2>
              <div className="flex justify-center pb-2">
                <ul className="inline-flex gap-3" role="listbox" aria-label="Timeframe options">
                  {OPTIONS[plan].map((opt) => {
                    const active = selected === opt.value
                    return (
                      <li key={opt.value}>
                        <OptionPill
                          active={active}
                          onClick={() => setSelected(opt.value)}
                          ariaLabel={`${opt.label} ${opt.unit}`}
                        >
                          {opt.label}
                        </OptionPill>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          )}

          {/* Price and Name */}
          <div>
            <div className="text-sm font-medium text-gray-400 mb-3">
              {plan === "consultation" ? "Consultation" : "Subscription"}
            </div>
            <div className="flex items-end gap-2">
              <span className="text-5xl md:text-6xl font-bold tracking-tight text-white">${activeOption?.price || 0}</span>
              <span className="text-gray-300 mb-2 text-lg">{activeOption?.unit}</span>
            </div>
          </div>

          {/* Feature list */}
          <div className="md:pt-2">
            <ul className="grid grid-cols-1 gap-y-4">
              {FEATURES[plan].map((feat) => (
                <li key={feat} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-[2px] inline-flex h-5 w-5 items-center justify-center rounded-full",
                      "border border-gray-600/50 bg-gray-800/60",
                      "shadow-sm relative flex-shrink-0",
                    )}
                  >
                    <CheckIcon className="h-3.5 w-3.5 text-white" />
                  </span>
                  <span className="text-sm md:text-base text-gray-200 leading-relaxed">{feat}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* CTA */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 pt-2">
            <Button
              onClick={handleBookNow}
              className={cn(
                "h-12 md:h-14 rounded-full px-8 md:px-10 font-bold text-base md:text-lg",
                "bg-white text-black hover:bg-gray-100",
                "shadow-xl hover:shadow-2xl",
                "transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]",
              )}
              aria-label={plan === "consultation" ? "Book Now" : "Choose Plan"}
            >
              {plan === "consultation" ? "Book Now" : "Choose Plan"}
            </Button>
            <p className="text-sm md:text-base text-gray-400 sm:ml-2">Secure checkout • No hidden fees</p>
          </div>
        </div>
      </div>
    </section>
  )
}

function SegmentedTrigger({
  isActive,
  onClick,
  children,
}: {
  isActive: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      className={cn(
        "relative w-full rounded-lg px-4 py-3 text-sm font-semibold transition-all duration-300",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
        isActive
          ? "bg-white text-black shadow-xl"
          : "text-gray-300 hover:text-white hover:bg-gray-700/60",
      )}
    >
      {children}
    </button>
  )
}

function OptionPill({
  active,
  onClick,
  ariaLabel,
  children,
}: {
  active: boolean
  onClick: () => void
  ariaLabel: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "relative rounded-full px-5 py-2.5 text-sm font-medium transition-all duration-300 whitespace-nowrap",
        "border backdrop-blur",
        active
          ? "bg-white text-black border-gray-300 shadow-lg ring-2 ring-white/20"
          : "bg-gray-800/60 text-gray-300 border-gray-700/50 hover:bg-gray-700/70 hover:text-white",
      )}
    >
      {children}
    </button>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default V0ConsultationPricing
