"use client";

import { use } from "react";
import { HelpTab } from "./HelpTab";

export default function HelpPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  return <HelpTab />;
}
