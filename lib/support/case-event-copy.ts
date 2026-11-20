/** The marker a conduct removal writes in its case's opening or join event to record the gateway order it ended. */
export const REMOVAL_ORDER_PREFIX = "removal-order:";

interface CaseEventValues {
  kind: string;
  fromValue: string | null;
  toValue: string | null;
}

const isRemovalOrderMarker = (value: string | null) =>
  value?.startsWith(REMOVAL_ORDER_PREFIX) ?? false;

/** A case event's values as staff read them: a removal's order marker becomes plain words and its order id never shows. */
export function readableCaseEvent(event: CaseEventValues): {
  fromValue: string | null;
  toValue: string | null;
  summary: string | null;
} {
  if (!isRemovalOrderMarker(event.fromValue)) {
    return {
      fromValue: event.fromValue,
      toValue: event.toValue,
      summary: null,
    };
  }
  return {
    fromValue: null,
    toValue: event.toValue,
    summary:
      event.kind === "REOPENED"
        ? "A new removal joined this review"
        : "Removal case opened",
  };
}

/** A case event's values as the learner receives them: the removal's order marker is dropped. */
export function learnerCaseEventValues(event: CaseEventValues): {
  fromValue: string | null;
  toValue: string | null;
} {
  const { fromValue, toValue } = readableCaseEvent(event);
  return { fromValue, toValue };
}
