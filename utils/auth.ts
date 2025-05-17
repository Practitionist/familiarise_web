// In a utility file, e.g., utils/auth.ts
import { Session } from "next-auth";

export function getEffectiveUserId(
  session: Session | null,
): string | undefined {
  if (session?.user?.id) {
    return session.user.id;
  } else if (
    process.env.NODE_ENV === "test" ||
    process.env.NODE_ENV === "development"
  ) {
    return process.env.NEXT_PUBLIC_TEST_USERID;
  }
  return undefined;
}
