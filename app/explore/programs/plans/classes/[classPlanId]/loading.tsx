export default function Loading() {
  return (
    <main className="min-h-screen bg-zinc-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-16 h-16 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
        <p className="text-zinc-500 text-sm">Loading class details...</p>
      </div>
    </main>
  );
}
