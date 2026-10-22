/** The resolved-problem cascade racing a problem reopen, on real Postgres. */
import type * as StageBellModule from "../../../lib/novu/stage-bell";
import prisma from "../../../lib/prisma";
import { stageBell } from "../../../lib/novu/stage-bell";
import { patchSupportCaseLifecycle } from "../../../lib/support/case-service";
import { cascadeResolvedProblems } from "../../../lib/support/problem-cascade";
import { caseVersion, seedCase, seedUser } from "../seed";

// A pass-through spy: staging stays real; the test uses it as the seam to reopen mid-run.
jest.mock("../../../lib/novu/stage-bell", () => {
  const actual = jest.requireActual<typeof StageBellModule>(
    "../../../lib/novu/stage-bell",
  );
  return { __esModule: true, ...actual, stageBell: jest.fn(actual.stageBell) };
});

const { stageBell: realStageBell } = jest.requireActual<typeof StageBellModule>(
  "../../../lib/novu/stage-bell",
);

it("does not resolve an incident whose problem was reopened after the scan", async () => {
  const staff = await seedUser("STAFF");
  const problem = await seedCase(staff.userId, {
    caseKind: "PROBLEM",
    category: "PLATFORM_OUTAGE",
    title: "Video calls failing",
  });
  const first = await seedCase((await seedUser()).userId, {
    problemCaseId: problem.id,
  });
  const second = await seedCase((await seedUser()).userId, {
    problemCaseId: problem.id,
  });
  // The cascade takes the least recently updated incident first.
  await prisma.supportCase.update({
    where: { id: first.id },
    data: { updatedAt: new Date(Date.now() - 120_000) },
  });
  await prisma.supportCase.update({
    where: { id: second.id },
    data: { updatedAt: new Date(Date.now() - 60_000) },
  });
  const resolved = await patchSupportCaseLifecycle({
    caseId: problem.id,
    actorId: staff.userId,
    expectedUpdatedAt: await caseVersion(problem.id),
    status: "RESOLVED",
    closingMessage: "The video provider fixed the outage",
  });
  expect(resolved.ok).toBe(true);

  // Both incidents are in the scan; the problem is reopened inside the first incident's transaction.
  let reopened: Awaited<ReturnType<typeof patchSupportCaseLifecycle>> | null =
    null;
  jest.mocked(stageBell).mockImplementation(async (tx, args) => {
    if (!reopened && args.entityRef?.startsWith(`case-status:${first.id}:`))
      reopened = await patchSupportCaseLifecycle({
        caseId: problem.id,
        actorId: staff.userId,
        expectedUpdatedAt: await caseVersion(problem.id),
        status: "IN_PROGRESS",
      });
    return realStageBell(tx, args);
  });

  const errors: string[] = [];
  await cascadeResolvedProblems({ limit: 50, now: new Date(), errors });

  expect(errors).toEqual([]);
  expect(reopened).toMatchObject({ ok: true });
  const [problemAfter, firstAfter, secondAfter] = await Promise.all(
    [problem.id, first.id, second.id].map((id) =>
      prisma.supportCase.findUniqueOrThrow({ where: { id } }),
    ),
  );
  expect(problemAfter.status).toBe("IN_PROGRESS");
  expect(firstAfter.status).toBe("RESOLVED");
  expect(secondAfter.status).toBe("OPEN");
  expect(secondAfter.resolvedAt).toBeNull();
  expect(
    await prisma.supportCaseEvent.count({
      where: { caseId: second.id, kind: "STATUS_CHANGED", toValue: "RESOLVED" },
    }),
  ).toBe(0);
});
