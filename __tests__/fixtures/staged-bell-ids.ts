import type { ScreenedRecipientEmails } from "@/lib/email/send-to-recipients";
import type { PreparedBell } from "@/lib/novu";
import type { Tx } from "@/lib/prisma";

interface PreparedNotices {
  bells: PreparedBell[];
  emails: ScreenedRecipientEmails;
}

/**
 * Stages one bell and no email through a notice stager on a transaction
 * double; answers the outbox transaction ids the stager wrote.
 */
export async function stagedBellTransactionIds(
  stage: (tx: Tx, prepared: PreparedNotices) => Promise<unknown>,
  bell: PreparedBell,
  emailType: string,
): Promise<string[]> {
  const createManyAndReturn = jest.fn(
    async (_args: { data: { transactionId: string }[] }) => [],
  );
  const tx = {
    notificationOutbox: { createManyAndReturn },
    failedEmail: { createManyAndReturn: jest.fn(async () => []) },
  } as unknown as Tx;
  await stage(tx, {
    bells: [bell],
    emails: {
      prepared: {
        emailType,
        entityRef: "pending",
        messages: [],
        skipped: 0,
        failed: 0,
      },
      screened: [],
    },
  });
  return createManyAndReturn.mock.calls[0][0].data.map(
    (row) => row.transactionId,
  );
}
