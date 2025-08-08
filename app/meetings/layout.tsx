import StreamVideoProvider from "@/providers/StreamClientProvider";
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
    <StreamVideoProvider userId={session.user.id}>
      {children}
    </StreamVideoProvider>
  );
}