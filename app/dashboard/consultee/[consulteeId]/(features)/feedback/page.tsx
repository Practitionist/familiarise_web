"use client";

import FeedbackSupportTab from "./FeedbackSupportTab";
import { use } from "react";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function FeedbackPage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  return <FeedbackSupportTab consulteeId={resolvedParams.consulteeId} />;
}
