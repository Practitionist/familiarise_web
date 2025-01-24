"use client";

import { use } from "react";
import { RequestSlotAllocationTab } from "./RequestSlotAllocationTab";

export default function RequestsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  const handleUpdate = () => {
    // Handled internally by RequestSlotAllocationTab
  };

  return <RequestSlotAllocationTab type="all" onUpdate={handleUpdate} />;
}
