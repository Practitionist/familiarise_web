/**
 * The delegates the earnings writer's member-overage check reads on a payment
 * that owes none: no legs (so no LICENSE leg) and no owed overage to lock.
 */
export function noMemberOverage(): object {
  return {
    paymentLeg: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
    overageEvent: { updateMany: jest.fn(async () => ({ count: 0 })) },
  };
}
