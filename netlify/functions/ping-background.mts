/** Throwaway diagnostic for #1454 — removed after one preview. */
export default async function pingBackground(req: Request): Promise<Response> {
  console.log(JSON.stringify({ event: "ping-background", method: req.method }));
  return new Response("ok");
}
