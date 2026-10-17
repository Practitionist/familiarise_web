export type ExpertService = "consultations" | "subscriptions";

type OfferingPlans = {
  consultationPlans: readonly { id: string }[];
  subscriptionPlans: readonly { id: string }[];
};

/** One selection drives the preview, price, details link and purchase. */
export function resolveOffering(
  plans: OfferingPlans,
  planId: string | null,
  service?: ExpertService,
) {
  const selectedService =
    service ??
    (plans.subscriptionPlans.some((plan) => plan.id === planId)
      ? "subscriptions"
      : plans.consultationPlans.length
        ? "consultations"
        : "subscriptions");
  const availableService = plans[
    selectedService === "consultations"
      ? "consultationPlans"
      : "subscriptionPlans"
  ].length
    ? selectedService
    : selectedService === "consultations"
      ? "subscriptions"
      : "consultations";
  const options =
    availableService === "consultations"
      ? plans.consultationPlans
      : plans.subscriptionPlans;
  return {
    service: availableService,
    planId: options.some((plan) => plan.id === planId)
      ? planId!
      : (options[0]?.id ?? ""),
  };
}
