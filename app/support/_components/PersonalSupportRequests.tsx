import { SupportRequestsPage } from "@/components/dashboard/shared/support/SupportRequestsPage";
import { SuggestedArticles } from "./SuggestedArticles";
import { ViewerZone } from "./ViewerZone";

/**
 * The personal trees' Support requests route body (#1527). One copy for both
 * trees; it lives in app/ because the suggested-articles slot reads Help Center
 * data, which components/ may not import.
 */
export function PersonalSupportRequests({
  tree,
  profileId,
}: Readonly<{
  tree: "consultant" | "consultee";
  profileId: string;
}>) {
  return (
    <ViewerZone>
      <SupportRequestsPage
        basePath={`/dashboard/${tree}/${profileId}`}
        suggested={
          <SuggestedArticles
            audience={tree === "consultant" ? "expert" : "learner"}
          />
        }
      />
    </ViewerZone>
  );
}
