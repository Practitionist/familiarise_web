"use client";

import { use } from "react";
import AppointmentsTab from "./AppointmentsTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function AppointmentsPage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  return <AppointmentsTab consulteeId={resolvedParams.consulteeId} />;
}
