# Product Analytics with PostHog - Implementation Guide

> **Priority:** 🟠 HIGH
> **Effort:** 4-6 hours
> **Dependencies:** None

## Executive Summary

PostHog is an all-in-one product analytics platform that replaces multiple tools. It provides product analytics, session replay, feature flags, A/B testing, and surveys in a single platform with a generous free tier.

---

## Table of Contents

1. [Why PostHog](#1-why-posthog)
2. [Installation](#2-installation)
3. [Configuration](#3-configuration)
4. [Event Tracking](#4-event-tracking)
5. [Session Replay](#5-session-replay)
6. [Feature Flags](#6-feature-flags)
7. [A/B Testing](#7-ab-testing)
8. [Dashboards](#8-dashboards)

---

## 1. Why PostHog

### What It Replaces

| Tool | Purpose | PostHog Feature |
|------|---------|-----------------|
| **Mixpanel** | Product analytics | ✅ Built-in |
| **Amplitude** | Funnels, cohorts | ✅ Built-in |
| **LogRocket** | Session replay | ✅ Built-in |
| **LaunchDarkly** | Feature flags | ✅ Built-in |
| **Optimizely** | A/B testing | ✅ Built-in |
| **Hotjar** | Heatmaps | ✅ Built-in |
| **Typeform** | Surveys | ✅ Built-in |

### Cost Comparison

```
BEFORE (Multiple tools):
├── Mixpanel Pro: $150/month
├── LaunchDarkly: $100/month
├── LogRocket: $99/month
└── Total: $349/month

AFTER (PostHog):
└── PostHog: $0-50/month (with startup credits)
    └── Savings: ~$300/month
```

### Key Features

- **Product Analytics:** Events, funnels, cohorts, retention
- **Session Replay:** Watch user sessions, debug issues
- **Feature Flags:** Gradual rollouts, targeting
- **A/B Testing:** Experiments with statistical significance
- **Heatmaps:** Click and scroll maps
- **Surveys:** In-app feedback collection

---

## 2. Installation

### Step 1: Install Packages

```bash
npm install posthog-js posthog-node
```

### Step 2: Get API Key

1. Go to [app.posthog.com](https://app.posthog.com)
2. Create project
3. Copy API key from Project Settings

### Step 3: Environment Variables

```env
# .env.local
NEXT_PUBLIC_POSTHOG_KEY=phc_xxxxxxxxxxxxxxxxxxxxx
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com

# For server-side (optional)
POSTHOG_PERSONAL_API_KEY=phx_xxxxxxxxxxxxxxxxxxxxx
```

---

## 3. Configuration

### PostHog Provider

```typescript
// providers/posthog-provider.tsx
"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      person_profiles: "identified_only",

      // Capture pageviews manually for App Router
      capture_pageview: false,
      capture_pageleave: true,

      // Session replay
      disable_session_recording: false,
      session_recording: {
        maskAllInputs: false,
        maskInputOptions: {
          password: true,
          // Don't mask these
          email: false,
          text: false,
        },
      },

      // Performance
      autocapture: true,
      capture_performance: true,

      // Privacy
      respect_dnt: true,
      opt_out_capturing_by_default: false,

      // Feature flags
      bootstrap: {
        featureFlags: {},
      },

      // Loaded callback
      loaded: (posthog) => {
        if (process.env.NODE_ENV === "development") {
          // Debug in dev
          posthog.debug();
        }
      },
    });
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}

// Pageview tracking component
export function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (pathname) {
      let url = window.origin + pathname;
      if (searchParams?.toString()) {
        url = url + `?${searchParams.toString()}`;
      }
      posthog.capture("$pageview", {
        $current_url: url,
      });
    }
  }, [pathname, searchParams]);

  return null;
}
```

### Add to Layout

```typescript
// app/layout.tsx
import { PostHogProvider, PostHogPageview } from "@/providers/posthog-provider";
import { Suspense } from "react";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <PostHogProvider>
          <Suspense fallback={null}>
            <PostHogPageview />
          </Suspense>
          {children}
        </PostHogProvider>
      </body>
    </html>
  );
}
```

### Identify Users

```typescript
// lib/posthog.ts
import posthog from "posthog-js";

export function identifyUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  plan?: string;
}) {
  posthog.identify(user.id, {
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
  });

  // Set super properties (sent with every event)
  posthog.register({
    user_role: user.role,
    user_plan: user.plan,
  });
}

export function resetUser() {
  posthog.reset();
}
```

### Call on Auth

```typescript
// In your auth callback or session provider
import { identifyUser, resetUser } from "@/lib/posthog";

// On sign in
useEffect(() => {
  if (session?.user) {
    identifyUser({
      id: session.user.id,
      email: session.user.email!,
      name: session.user.name!,
      role: session.user.role,
      plan: session.user.subscription?.plan,
    });
  }
}, [session]);

// On sign out
async function handleSignOut() {
  resetUser();
  await signOut();
}
```

---

## 4. Event Tracking

### Core Events to Track

```typescript
// lib/analytics/events.ts
import posthog from "posthog-js";

// Authentication Events
export const authEvents = {
  signUp: (method: "email" | "google" | "github") => {
    posthog.capture("user_signed_up", { method });
  },

  signIn: (method: "email" | "google" | "github") => {
    posthog.capture("user_signed_in", { method });
  },

  signOut: () => {
    posthog.capture("user_signed_out");
  },

  onboardingCompleted: (role: string) => {
    posthog.capture("onboarding_completed", { role });
  },
};

// Consultation Events
export const consultationEvents = {
  viewedPlan: (planId: string, consultantId: string, price: number) => {
    posthog.capture("consultation_plan_viewed", {
      plan_id: planId,
      consultant_id: consultantId,
      price,
    });
  },

  startedCheckout: (planId: string, planType: string, amount: number) => {
    posthog.capture("checkout_started", {
      plan_id: planId,
      plan_type: planType,
      amount,
    });
  },

  completedCheckout: (
    planId: string,
    planType: string,
    amount: number,
    paymentMethod: string
  ) => {
    posthog.capture("checkout_completed", {
      plan_id: planId,
      plan_type: planType,
      amount,
      payment_method: paymentMethod,
      $set: {
        last_purchase_date: new Date().toISOString(),
        total_spent: { $increment: amount },
      },
    });
  },

  bookingCreated: (appointmentId: string, consultantId: string) => {
    posthog.capture("booking_created", {
      appointment_id: appointmentId,
      consultant_id: consultantId,
    });
  },

  bookingCancelled: (appointmentId: string, reason?: string) => {
    posthog.capture("booking_cancelled", {
      appointment_id: appointmentId,
      reason,
    });
  },
};

// Search Events
export const searchEvents = {
  searched: (query: string, filters: Record<string, any>, resultCount: number) => {
    posthog.capture("search_performed", {
      query,
      filters,
      result_count: resultCount,
    });
  },

  clickedResult: (resultId: string, position: number) => {
    posthog.capture("search_result_clicked", {
      result_id: resultId,
      position,
    });
  },
};

// Engagement Events
export const engagementEvents = {
  viewedConsultant: (consultantId: string) => {
    posthog.capture("consultant_profile_viewed", {
      consultant_id: consultantId,
    });
  },

  startedChat: (channelId: string, participantCount: number) => {
    posthog.capture("chat_started", {
      channel_id: channelId,
      participant_count: participantCount,
    });
  },

  joinedMeeting: (meetingId: string) => {
    posthog.capture("meeting_joined", {
      meeting_id: meetingId,
    });
  },

  leftReview: (consultantId: string, rating: number) => {
    posthog.capture("review_submitted", {
      consultant_id: consultantId,
      rating,
    });
  },
};

// Error Events
export const errorEvents = {
  paymentFailed: (planId: string, errorCode: string, errorMessage: string) => {
    posthog.capture("payment_failed", {
      plan_id: planId,
      error_code: errorCode,
      error_message: errorMessage,
    });
  },

  bookingFailed: (reason: string) => {
    posthog.capture("booking_failed", { reason });
  },
};
```

### Usage Examples

```typescript
// In checkout component
import { consultationEvents } from "@/lib/analytics/events";

function CheckoutButton({ plan }: { plan: Plan }) {
  const handleClick = () => {
    consultationEvents.startedCheckout(
      plan.id,
      plan.type,
      plan.price
    );
    router.push(`/checkout/${plan.id}`);
  };

  return <button onClick={handleClick}>Book Now</button>;
}

// After successful payment
consultationEvents.completedCheckout(
  plan.id,
  plan.type,
  payment.amount,
  payment.method
);
```

---

## 5. Session Replay

### Configuration

```typescript
// Already configured in provider, but can customize
posthog.init(key, {
  session_recording: {
    // Don't mask most inputs
    maskAllInputs: false,
    maskInputOptions: {
      password: true,
    },

    // Mask specific elements
    maskTextSelector: ".sensitive-data",

    // Block recording on specific pages
    blockSelector: ".no-record",

    // Console log recording
    recordConsoleLog: true,

    // Canvas recording (for charts)
    recordCanvas: true,
  },
});
```

### Manual Recording Control

```typescript
// Start recording
posthog.startSessionRecording();

// Stop recording
posthog.stopSessionRecording();

// Check if recording
const isRecording = posthog.isSessionRecordingEnabled();
```

### Privacy Controls

```typescript
// Opt out specific users
if (user.optedOutOfTracking) {
  posthog.opt_out_capturing();
}

// Mask dynamic content
<div className="no-record">
  <CreditCardForm />
</div>
```

---

## 6. Feature Flags

### Creating Flags in PostHog

1. Go to Feature Flags in PostHog
2. Create new flag with key (e.g., `new-checkout-flow`)
3. Set rollout percentage or targeting rules

### Using Flags (Client-Side)

```typescript
// hooks/useFeatureFlag.ts
import { useFeatureFlagEnabled, useFeatureFlagPayload } from "posthog-js/react";

// Boolean flag
export function useNewCheckoutFlow() {
  return useFeatureFlagEnabled("new-checkout-flow");
}

// Flag with payload
export function useExperimentConfig() {
  return useFeatureFlagPayload("experiment-config");
}
```

```typescript
// In component
function CheckoutPage() {
  const showNewFlow = useNewCheckoutFlow();

  if (showNewFlow) {
    return <NewCheckoutFlow />;
  }

  return <LegacyCheckoutFlow />;
}
```

### Using Flags (Server-Side)

```typescript
// lib/posthog-server.ts
import { PostHog } from "posthog-node";

const posthog = new PostHog(process.env.POSTHOG_PERSONAL_API_KEY!, {
  host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
});

export async function getFeatureFlag(
  flagKey: string,
  userId: string,
  properties?: Record<string, any>
): Promise<boolean | string | undefined> {
  return posthog.getFeatureFlag(flagKey, userId, {
    personProperties: properties,
  });
}

// Cleanup on shutdown
export async function shutdownPostHog() {
  await posthog.shutdown();
}
```

```typescript
// In API route
import { getFeatureFlag } from "@/lib/posthog-server";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);

  const useNewPricing = await getFeatureFlag(
    "new-pricing-model",
    session!.user.id,
    { plan: session!.user.plan }
  );

  if (useNewPricing) {
    // Use new pricing logic
  }
}
```

### Gradual Rollouts

```typescript
// Feature flag configuration in PostHog dashboard
{
  "key": "new-dashboard",
  "filters": {
    "rollout_percentage": 20,  // 20% of users
    "groups": [
      {
        "properties": [
          { "key": "plan", "value": "pro", "operator": "exact" }
        ],
        "rollout_percentage": 100  // 100% of pro users
      }
    ]
  }
}
```

---

## 7. A/B Testing

### Creating an Experiment

1. Go to Experiments in PostHog
2. Create new experiment
3. Set variants and goals

### Using Experiments

```typescript
// hooks/useExperiment.ts
import { useFeatureFlagVariantKey } from "posthog-js/react";
import posthog from "posthog-js";

export function useCheckoutExperiment() {
  const variant = useFeatureFlagVariantKey("checkout-experiment");

  // Track exposure
  useEffect(() => {
    if (variant) {
      posthog.capture("$experiment_exposure", {
        $feature_flag: "checkout-experiment",
        $feature_flag_response: variant,
      });
    }
  }, [variant]);

  return variant; // "control" | "variant-a" | "variant-b"
}
```

```typescript
// In component
function PricingPage() {
  const variant = useCheckoutExperiment();

  switch (variant) {
    case "variant-a":
      return <PricingLayoutA />;
    case "variant-b":
      return <PricingLayoutB />;
    default:
      return <PricingLayoutControl />;
  }
}
```

### Tracking Conversions

```typescript
// When user converts (e.g., completes checkout)
posthog.capture("checkout_completed", {
  plan_id: planId,
  amount: amount,
  // PostHog automatically attributes to experiment
});
```

---

## 8. Dashboards

### Key Dashboards to Create

#### 1. User Acquisition Dashboard

```
Metrics:
├── Daily/Weekly/Monthly Active Users
├── New signups by source
├── Signup conversion funnel
├── Onboarding completion rate
└── Time to first booking
```

#### 2. Revenue Dashboard

```
Metrics:
├── Daily/Monthly revenue
├── Average order value
├── Conversion rate by plan type
├── Checkout abandonment rate
└── Revenue by payment method
```

#### 3. Engagement Dashboard

```
Metrics:
├── Consultations completed
├── Average session duration
├── Features used per session
├── Search usage and success rate
└── Chat engagement
```

#### 4. Retention Dashboard

```
Metrics:
├── User retention cohorts
├── Churn rate
├── Repeat booking rate
├── NPS score (from surveys)
└── Feature adoption over time
```

### Creating Funnels

```
Checkout Funnel:
1. consultation_plan_viewed
2. checkout_started
3. payment_initiated
4. checkout_completed

Onboarding Funnel:
1. user_signed_up
2. profile_created
3. first_search
4. first_booking
```

### Cohort Analysis

```
Define cohorts by:
├── Sign-up date
├── Plan type
├── First booking date
├── Payment method used
└── Feature flags exposed
```

---

## Quick Reference

### Common Event Patterns

```typescript
// Page events (automatic with provider)
posthog.capture("$pageview");
posthog.capture("$pageleave");

// User events
posthog.identify("user_id", { email, name });
posthog.reset(); // On logout

// Custom events
posthog.capture("event_name", { property: "value" });

// Group analytics
posthog.group("company", "company_id", { name: "Acme" });

// Super properties (sent with every event)
posthog.register({ app_version: "1.0.0" });
posthog.unregister("app_version");
```

### Environment Variables

```env
# Required
NEXT_PUBLIC_POSTHOG_KEY=phc_xxx
NEXT_PUBLIC_POSTHOG_HOST=https://app.posthog.com

# Optional (for server-side)
POSTHOG_PERSONAL_API_KEY=phx_xxx
```

### Verification Checklist

- [ ] PostHog packages installed
- [ ] Environment variables set
- [ ] Provider added to layout
- [ ] Pageview tracking working
- [ ] User identification on auth
- [ ] Core events implemented
- [ ] Session replay enabled
- [ ] Feature flags configured
- [ ] Key dashboards created
- [ ] Funnels set up
