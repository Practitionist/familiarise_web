/**
 * Whether a Razorpay error answer says the id is not on record: a 404, or a
 * 400 whose description names the id. Any other 400 is a refusal of the
 * request, and says nothing about whether the id exists.
 */
export function isUnknownIdAnswer(
  status: unknown,
  description: unknown,
): boolean {
  if (status === 404) return true;
  return (
    status === 400 &&
    typeof description === "string" &&
    /does not exist|not found|invalid id/i.test(description)
  );
}
