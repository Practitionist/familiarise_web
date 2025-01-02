"use client";

import HomeTab from "./HomeTab";
import { useUser } from "../../UserContext";
import { use } from "react";

type PageProps = {
  params: Promise<{ consulteeId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function HomePage({ params }: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const { userDetails } = useUser();
  return <HomeTab params={params} userDetails={userDetails} />;
}
