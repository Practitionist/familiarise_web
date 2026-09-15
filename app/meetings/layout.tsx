import "@stream-io/video-react-sdk/dist/css/styles.css";
import StreamProvider from "@/providers/StreamProvider";
import { StreamVideoScope } from "@/components/stream/StreamVideoScope";
import { StreamInitialTokensProvider } from "@/components/stream/StreamInitialTokens";
import { requireOnboarded } from "@/lib/auth-guard";
import { mintInitialStreamTokens } from "@/lib/stream/initial-tokens";

export default async function MeetingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensure user is authenticated and onboarded for meetings
  const session = await requireOnboarded();
  // Video only: the first connect on a direct landing needs no token round
  // trip to a possibly stalled instance (#1124, FAMILIARISE_WEB-3N).
  const streamTokens = mintInitialStreamTokens(session.user.id, {
    chat: false,
    video: true,
  });

  return (
    <StreamInitialTokensProvider tokens={streamTokens}>
      <StreamProvider
        userId={session.user.id}
        enableChat={false}
        enableVideo={true}
      >
        {/* /meetings is the video surface, so the SDK context is mounted for the
            whole route rather than per-page. StreamProvider no longer supplies it
            — see components/stream/StreamVideoScope. */}
        <StreamVideoScope>{children}</StreamVideoScope>
      </StreamProvider>
    </StreamInitialTokensProvider>
  );
}
