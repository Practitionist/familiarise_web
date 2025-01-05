"use client";

import { use } from "react";
import SettingsTab from "./SettingsTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function SettingsPage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  return <SettingsTab consulteeId={resolvedParams.consulteeId} />;
}
