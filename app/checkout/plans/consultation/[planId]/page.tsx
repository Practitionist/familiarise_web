"use client";

import { use } from "react";

import { useConsultationCheckout } from "../../adapters/use-consultation-checkout";
import { PlanCheckoutShell } from "../../components/PlanCheckoutShell";

type PageProps = {
  params: Promise<{ planId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ConsultationCheckoutPage({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const { planId } = use(params);
  const resolvedSearchParams = use(searchParams);
  return (
    <PlanCheckoutShell
      useAdapter={useConsultationCheckout}
      planId={planId}
      searchParams={resolvedSearchParams}
    />
  );
}
