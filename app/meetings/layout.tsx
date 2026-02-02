import StreamProvider from "@/providers/StreamProvider";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-server";
export default async function MeetingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensure user is authenticated for meetings
  const session = await getSession();

  if (!session?.user?.id) {
    redirect("/auth/signin");
  }

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
