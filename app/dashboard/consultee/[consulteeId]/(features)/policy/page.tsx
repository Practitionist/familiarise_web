"use client";

import PolicyTab from "./PolicyTab";
import { use } from "react";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function PolicyPage({
  params,
}: Readonly<PageProps>) {
  const resolvedParams = use(params);
  return <PolicyTab consulteeId={resolvedParams.consulteeId} />;
}
