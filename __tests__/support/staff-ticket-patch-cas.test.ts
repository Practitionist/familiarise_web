/** @jest-environment node */
import { PATCH } from "../../app/api/staff/support-tickets/[ticketId]/route";
import { POST } from "../../app/api/staff/support-tickets/[ticketId]/responses/route";
it("retired ticket mutations cannot create a second support history", async () => {
  expect(PATCH().status).toBe(410);
  expect(POST().status).toBe(410);
  expect(await PATCH().json()).toMatchObject({ code: "ENDPOINT_RETIRED" });
});
