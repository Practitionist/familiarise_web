"use client";

import { use } from "react";

import { useClassCheckout } from "../../adapters/use-class-checkout";
import { PlanCheckoutShell } from "../../components/PlanCheckoutShell";

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ClassCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { planId } = use(params);
  const resolvedSearchParams = use(searchParams);
  return (
    <PlanCheckoutShell
      useAdapter={useClassCheckout}
      planId={planId}
      searchParams={resolvedSearchParams}
    />
  );
}
