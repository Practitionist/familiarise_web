import StreamProvider from "@/providers/StreamProvider";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import authOptions from "../api/auth/[...nextauth]/options";

export default async function MeetingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensure user is authenticated for meetings
  const session = await getServerSession(authOptions);

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
