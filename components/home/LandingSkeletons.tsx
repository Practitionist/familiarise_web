import { LandingContainer } from "./LandingShared";

export function ReviewSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading reviews"
      className="bg-[#f7f7f3] py-16 sm:py-20 lg:py-24"
    >
      <LandingContainer>
        <div aria-hidden="true" className="motion-safe:animate-pulse">
          <div className="h-9 w-full max-w-lg rounded bg-zinc-200/60" />
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {[1, 2, 3].map((key) => (
              <div key={key} className="h-[260px] rounded-2xl bg-zinc-200/60" />
            ))}
          </div>
        </div>
      </LandingContainer>
    </section>
  );
}
