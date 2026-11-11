/** The support, digital product, waitlist and referral models `scrubUser` touches, answering as for a user with no history. */
export function supportScrubModels() {
  const none = () => jest.fn(async () => ({ count: 0 }));
  return {
    supportCase: { updateMany: none() },
    supportCaseMessage: { updateMany: none() },
    supportCaseEvidenceRequest: { updateMany: none() },
    supportCaseAttachment: {
      findMany: jest.fn(async () => []),
      updateMany: none(),
    },
    digitalProduct: { findMany: jest.fn(async () => []), updateMany: none() },
    digitalProductAsset: {
      findMany: jest.fn(async () => []),
      updateMany: none(),
    },
    digitalProductDownload: { deleteMany: none() },
    digitalProductPurchase: { deleteMany: none() },
    digitalProductReport: { updateMany: none() },
    appointmentWaitlist: { deleteMany: none() },
    windowBackupInterest: { deleteMany: none() },
    referral: { updateMany: none() },
  };
}
