import { render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";

import { Form } from "@/components/ui/form";

// The session-time field reads the signed-in user's zone; this suite renders other fields.
jest.mock("@/components/offerings/editor/session-time-field", () => ({
  SessionTimeField: () => null,
}));
import { OfferingField } from "@/components/offerings/editor/OfferingFields";
import { WaitingCountProvider } from "@/components/offerings/editor/waiting-count";
import type { FieldSpec } from "@/components/offerings/editor/manifest";

const spec: FieldSpec = {
  name: "maxParticipants",
  kind: "number",
  label: "Max participants",
};

function Harness({
  plan,
  instance,
}: {
  plan: number | null;
  instance: number;
}) {
  const form = useForm({ defaultValues: { maxParticipants: 10 } });
  return (
    <WaitingCountProvider value={{ plan, instance }}>
      <Form {...form}>
        <OfferingField control={form.control} spec={spec} />
      </Form>
    </WaitingCountProvider>
  );
}

it("hints with the edited batch's own count, not the plan's", () => {
  render(<Harness plan={7} instance={3} />);
  expect(
    screen.getByText("3 waiting — raising capacity notifies them."),
  ).toBeTruthy();
});

it("shows no hint when the edited batch has nobody waiting", () => {
  render(<Harness plan={7} instance={0} />);
  expect(screen.queryByText(/raising capacity notifies them/)).toBeNull();
});
