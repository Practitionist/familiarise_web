import "@stream-io/video-react-sdk/dist/css/styles.css";
import StreamProvider from "@/providers/StreamProvider";
import { requireOnboarded } from "@/lib/auth-guard";

export default async function MeetingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensure user is authenticated and onboarded for meetings
  const session = await requireOnboarded();

  return (
    <StreamProvider
      userId={session.user.id}
      enableChat={false}
      enableVideo={true}
    >
      {children}
    </StreamProvider>
  );
}
