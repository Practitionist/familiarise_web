// TEMPORARY experiment for #1119. Removed before merge. An ISR route shaped
// exactly like /explore/experts/[consultantId] (revalidate + generateStaticParams
// returning []) whose render can be made to throw, so the question "does a thrown
// ISR render get written into the Netlify durable cache" can be answered by
// observation instead of by reading framework docs.
export const revalidate = 10;

export function generateStaticParams() {
  return [];
}

// `flaky` alternates on a 30s wall-clock boundary, which every instance agrees on,
// so a revalidation can be made to land on a throwing render on purpose.
function shouldThrow(k: string): boolean {
  if (k === "throw") return true;
  if (k === "flaky") return Math.floor(Date.now() / 30_000) % 2 === 1;
  return false;
}

export default async function Diag({
  params,
}: Readonly<{ params: Promise<{ k: string }> }>) {
  const { k } = await params;
  if (shouldThrow(k)) {
    throw Object.assign(new Error("pool timeout"), { code: "P2024" });
  }
  return (
    <main>
      <h1>DIAG-OK</h1>
      <p>rendered-at {new Date().toISOString()}</p>
    </main>
  );
}
