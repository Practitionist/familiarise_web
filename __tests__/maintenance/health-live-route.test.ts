/**
 * @jest-environment node
 */
import { GET } from "@/app/api/health/live/route";

it("answers 200 without touching any dependency, uncached", async () => {
  const res = GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.json()).toEqual({ status: "ok" });
});
