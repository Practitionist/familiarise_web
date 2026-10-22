import {
  MESSAGE_REVIEW_ARTICLE_HREF,
  MESSAGE_REVIEW_NOTICE,
} from "@/lib/compliance/purpose-codes";

export function MessageReviewNotice() {
  return (
    <p>
      {MESSAGE_REVIEW_NOTICE} See{" "}
      <a
        href={MESSAGE_REVIEW_ARTICLE_HREF}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        How and why we review messages
      </a>
      .
    </p>
  );
}
