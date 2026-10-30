"use client";

import { useParams } from "next/navigation";
import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { NewOfferingMenu } from "@/components/offerings/list/NewOfferingMenu";
import { OfferingsTabs } from "@/components/offerings/list/OfferingsTabs";
import { DigitalProductList } from "@/components/offerings/list/DigitalProductList";

export default function DigitalProductsPage() {
  const consultantId = useParams().consultantId as string;
  return (
    <>
      <DashboardHeader
        title="Offerings"
        description="Files you sell once, for buyers to keep"
        actions={<NewOfferingMenu consultantId={consultantId} />}
      />
      <OfferingsTabs consultantId={consultantId} />
      <DashboardContent>
        <DigitalProductList consultantId={consultantId} />
      </DashboardContent>
    </>
  );
}
