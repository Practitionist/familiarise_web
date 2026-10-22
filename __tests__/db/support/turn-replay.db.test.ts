/** A double-sent customer turn through appendSupportCaseTurn on real Postgres (ports the retired raw-SQL check). */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { appendSupportCaseTurn } from "../../../lib/support/case-service";
import {
  lockCaseRow,
  raceBehindLock,
  seedCase,
  seedUser,
  settledValues,
} from "../seed";

it("stores one message for a clientTurnId sent twice and replays it to the loser", async () => {
  const customer = await seedUser();
  const supportCase = await seedCase(customer.userId);
  const clientTurnId = randomUUID();
  const send = () =>
    appendSupportCaseTurn({
      caseId: supportCase.id,
      authorUserId: customer.userId,
      sender: "USER",
      body: "Is anyone there?",
      isInternal: false,
      clientTurnId,
    });

  // Both pass the replay lookup, then queue on the case row's sequence bump.
  const { fulfilled, rejected } = settledValues(
    await raceBehindLock(lockCaseRow(supportCase.id), [send, send]),
  );

  expect(rejected).toEqual([]);
  const turns = fulfilled.flatMap((result) => (result.ok ? [result] : []));
  expect(turns).toHaveLength(2);
  const written = turns.find((turn) => !turn.replayed);
  const replayed = turns.find((turn) => turn.replayed);
  expect(written?.messages).toHaveLength(1);
  expect(replayed?.messages[0]?.id).toBe(written?.messages[0]?.id);

  const stored = await prisma.supportCaseMessage.findMany({
    where: { caseId: supportCase.id },
    orderBy: { seq: "asc" },
  });
  expect(stored.map((message) => message.seq)).toEqual([1, 2]);
  expect(
    stored.filter((message) => message.clientTurnId === clientTurnId),
  ).toHaveLength(1);
  const after = await prisma.supportCase.findUniqueOrThrow({
    where: { id: supportCase.id },
  });
  // The loser's sequence bump rolled back with its duplicate insert.
  expect(after.messageSeq).toBe(2);
});
