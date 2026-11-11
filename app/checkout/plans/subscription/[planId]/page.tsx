"use client";

import { use } from "react";

import { useSubscriptionCheckout } from "../../adapters/use-subscription-checkout";
import { PlanCheckoutShell } from "../../components/PlanCheckoutShell";

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function SubscriptionCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { planId } = use(params);
  const resolvedSearchParams = use(searchParams);
  return (
    <PlanCheckoutShell
      useAdapter={useSubscriptionCheckout}
      planId={planId}
      searchParams={resolvedSearchParams}
    />
  );
}
