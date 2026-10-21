/** The support models `scrubUser` touches, answering as for a user with no support history. */
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
  };
}
