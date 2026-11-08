import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";

import { Form, FormField, FormItem } from "@/components/ui/form";
import { WaitingCountProvider } from "@/components/offerings/editor/waiting-count";
import { WaitlistSwitch } from "@/components/offerings/editor/WaitlistSwitch";

const onChange = jest.fn();

function Harness() {
  const form = useForm({ defaultValues: { waitlistEnabled: true } });
  return (
    <Form {...form}>
      <FormField
        control={form.control}
        name="waitlistEnabled"
        render={({ field }) => (
          <FormItem>
            <WaitlistSwitch
              checked={field.value}
              onCheckedChange={(next) => {
                onChange(next);
                field.onChange(next);
              }}
            />
          </FormItem>
        )}
      />
    </Form>
  );
}

function renderWith(waiting: number | null) {
  render(
    <WaitingCountProvider value={{ plan: waiting, instance: 0 }}>
      <Harness />
    </WaitingCountProvider>,
  );
}

beforeEach(() => onChange.mockClear());

it("switches off straight away with nobody waiting", () => {
  renderWith(0);
  fireEvent.click(screen.getByRole("switch"));
  expect(screen.queryByText("Turn off the waitlist?")).toBeNull();
  expect(onChange).toHaveBeenCalledWith(false);
});

it("asks first when people are waiting, and keeps it on if declined", () => {
  renderWith(4);
  fireEvent.click(screen.getByRole("switch"));
  expect(screen.getByText("Turn off the waitlist?")).toBeTruthy();
  expect(
    screen.getByText(/4 people waiting will no longer be notified/),
  ).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Keep waitlist"));
  expect(onChange).not.toHaveBeenCalled();
});

it("turns it off once confirmed", () => {
  renderWith(2);
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.click(screen.getByText("Turn off"));
  expect(onChange).toHaveBeenCalledWith(false);
});

it("asks with generic copy while the count is unknown", () => {
  renderWith(null);
  fireEvent.click(screen.getByRole("switch"));
  expect(screen.getByText("Turn off the waitlist?")).toBeTruthy();
  expect(
    screen.getByText(/Anyone waiting will no longer be notified/),
  ).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
});
