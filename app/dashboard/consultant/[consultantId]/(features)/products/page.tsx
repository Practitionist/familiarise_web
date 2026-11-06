import Link from "next/link";
import { Plus } from "lucide-react";

import {
  DashboardContent,
  DashboardHeader,
} from "@/components/dashboard/PageScaffold";
import { DigitalProductList } from "@/components/offerings/list/DigitalProductList";
import { Button } from "@/components/ui/button";

export default async function ProductsPage({
  params,
}: Readonly<{ params: Promise<{ consultantId: string }> }>) {
  const { consultantId } = await params;
  return (
    <>
      <DashboardHeader
        title="Products"
        description="Files you sell once, for buyers to keep"
        actions={
          <Button asChild size="sm">
            <Link
              href={`/dashboard/consultant/${consultantId}/offerings/digital-product/new`}
            >
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />
              New digital product
            </Link>
          </Button>
        }
      />
      <DashboardContent>
        <DigitalProductList consultantId={consultantId} />
      </DashboardContent>
    </>
  );
}
