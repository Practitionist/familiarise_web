/** @jest-environment node */
import {
  GET,
  POST,
  DELETE,
} from "../../app/api/support-tickets/[ticketId]/attachments/route";
it("retired attachment mutations expose no storage credentials or legacy reads", async () => {
  for (const handler of [GET, POST, DELETE]) {
    const response = handler();
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: "Use the evidence actions on the unified support case.",
      code: "ENDPOINT_RETIRED",
    });
  }
});
