/**
 * @jest-environment node
 */
import {
  adminActorId,
  currentRun,
  noteCounter,
  noteRunId,
  withRunContext,
} from "../../lib/cron/run-context";
import { casMiss } from "../../lib/cron/run-counters";

describe("run context", () => {
  it("is a no-op outside a run", () => {
    expect(currentRun()).toBeUndefined();
    expect(() => {
      casMiss();
      noteCounter("poolTimeout");
      noteRunId("exec-x");
    }).not.toThrow();
    expect(adminActorId()).toBeUndefined();
  });

  it("keeps counters and run ids per run, across awaits and timers, and isolates concurrent runs", async () => {
    const run = (triggeredBy: string, misses: number) =>
      withRunContext({ triggeredBy, tickId: "tick-1" }, async () => {
        for (let i = 0; i < misses; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          casMiss();
        }
        noteRunId(`exec-${triggeredBy}`);
        return currentRun();
      });
    const [cron, admin] = await Promise.all([
      run("cron", 2),
      run("admin:user-7", 1),
    ]);
    expect(cron?.counters.casMiss).toBe(2);
    expect(cron?.runIds).toEqual(["exec-cron"]);
    expect(admin?.counters).toMatchObject({ casMiss: 1, poolTimeout: 0 });
    expect(admin?.tickId).toBe("tick-1");
    expect(currentRun()).toBeUndefined();
  });

  it("names the admin actor only for admin triggers", async () => {
    await withRunContext({ triggeredBy: "admin-drain:user-9" }, async () => {
      expect(adminActorId()).toBe("user-9");
    });
    await withRunContext({ triggeredBy: "cron" }, async () => {
      expect(adminActorId()).toBeUndefined();
    });
  });
});
