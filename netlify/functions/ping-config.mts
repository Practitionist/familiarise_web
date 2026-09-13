/** Throwaway diagnostic for #1454 — removed after one preview. */
export const config = { background: true };
export default async function pingConfig(req: Request): Promise<Response> {
  console.log(JSON.stringify({ event: "ping-config", method: req.method }));
  return new Response("ok");
}
