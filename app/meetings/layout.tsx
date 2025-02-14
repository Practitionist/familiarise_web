import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';

export default async function MeetingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();

  if (!session?.user) {
    redirect('/auth/signin');
  }

  return (
    <main className="min-h-screen bg-background">
      {children}
    </main>
  );
}
