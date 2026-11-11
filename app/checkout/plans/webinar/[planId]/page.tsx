"use client";

import { use } from "react";

import { useWebinarCheckout } from "../../adapters/use-webinar-checkout";
import { PlanCheckoutShell } from "../../components/PlanCheckoutShell";

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function WebinarCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { planId } = use(params);
  const resolvedSearchParams = use(searchParams);
  return (
    <PlanCheckoutShell
      useAdapter={useWebinarCheckout}
      planId={planId}
      searchParams={resolvedSearchParams}
    />
  );
}
