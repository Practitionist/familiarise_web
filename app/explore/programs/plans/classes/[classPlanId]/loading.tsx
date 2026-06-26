export default function Loading() {
  return (
    <main className="min-h-screen bg-muted flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-16 h-16 border-4 border-border border-t-foreground rounded-full animate-spin" />
        <p className="text-muted-foreground text-sm">Loading class details...</p>
      </div>
    </main>
  );
}
