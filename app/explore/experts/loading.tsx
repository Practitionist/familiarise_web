export default function Loading() {
  return (
    <main className="explore-page min-h-screen">
      <section className="relative pt-12 pb-12 bg-[#faf9f6]">
        <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12">
          <div className="max-w-4xl mx-auto text-center">
            <div className="h-8 w-48 bg-muted rounded-full mx-auto mb-8 animate-pulse" />
            <div className="h-12 w-full max-w-xl bg-muted rounded-lg mx-auto mb-6 animate-pulse" />
            <div className="h-6 w-64 bg-muted rounded-lg mx-auto animate-pulse" />
          </div>
        </div>
      </section>
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 lg:px-12 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-72 bg-muted rounded-2xl animate-pulse" />
          ))}
        </div>
      </div>
    </main>
  );
}
