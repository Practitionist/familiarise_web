import type { Metadata } from "next";

import { FileViewer, FileViewerError } from "@/components/documents/FileViewer";
import { getSession } from "@/lib/auth-server";
import { authorizePlanMaterial } from "@/lib/documents/file-access";
import { getMaterialViewerUrl } from "@/lib/documents/urls";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Material",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function MaterialViewerPage({
  params,
}: Readonly<{ params: Promise<{ materialId: string }> }>) {
  const { materialId } = await params;
  const callbackPath = getMaterialViewerUrl(materialId);
  const session = await getSession();
  if (!session?.user?.id) {
    return <FileViewerError code="UNAUTHORIZED" callbackPath={callbackPath} />;
  }
  const access = await authorizePlanMaterial(session.user.id, materialId);
  return <FileViewer access={access} callbackPath={callbackPath} />;
}
