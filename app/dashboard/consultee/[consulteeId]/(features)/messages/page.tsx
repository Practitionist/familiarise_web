"use client";

import MessagesTab from "./MessagesTab";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function MessagesPage({ params }: Readonly<PageProps>) {
  return <MessagesTab />;
}
