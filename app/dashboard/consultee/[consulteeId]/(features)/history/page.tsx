"use client";

import BookingHistoryTab from "./BookingHistoryTab";
import { use } from "react";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function HistoryPage({
  params,
}: Readonly<PageProps>) {
  const resolvedParams = use(params);
  return <BookingHistoryTab consulteeId={resolvedParams.consulteeId} />;
}
