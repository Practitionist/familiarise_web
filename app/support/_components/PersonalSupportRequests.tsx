import { permanentRedirect } from "next/navigation";
import { SupportRequestsPage } from "@/components/dashboard/shared/support/SupportRequestsPage";
import { SuggestedArticles } from "./SuggestedArticles";

/**
 * The personal trees' Support requests route body (#1527). One copy for both
 * trees; it lives in app/ because the suggested-articles slot reads Help Center
 * data, which components/ may not import.
 */
export function PersonalSupportRequests({
  tree,
  profileId,
  tab,
}: Readonly<{
  tree: "consultant" | "consultee";
  profileId: string;
  tab: string | string[] | undefined;
}>) {
  // The retired Help center tab: articles live only in the public Help Center.
  if (tab === "help") permanentRedirect("/support");
  return (
    <SupportRequestsPage
      profileId={profileId}
      basePath={`/dashboard/${tree}/${profileId}`}
      suggested={
        <SuggestedArticles
          audience={tree === "consultant" ? "expert" : "learner"}
        />
      }
    />
  );
}
