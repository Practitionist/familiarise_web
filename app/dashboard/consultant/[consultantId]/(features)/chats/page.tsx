"use client";

import { use } from "react";
import { ChatsTab } from "./ChatsTab";

export default function ChatsPage({
  params,
}: Readonly<{
  params: Promise<{ consultantId: string }>;
}>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  return <ChatsTab />;
}
