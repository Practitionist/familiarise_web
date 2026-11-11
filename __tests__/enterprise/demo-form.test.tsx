/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DemoForm } from "@/app/enterprise/demo/DemoForm";

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(new RegExp(label)), {
    target: { value },
  });

function fillRequired() {
  fill("First name", "Asha");
  fill("Last name", "Rao");
  fill("Work email", "asha@acme.example");
  fill("Company or institution", "Acme");
  fill("What are you trying to solve", "Mentoring for managers");
}

describe("DemoForm", () => {
  it("sends one request when submitted twice before the first settles", async () => {
    let finish: (v: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { container } = render(<DemoForm initialUseCase="" />);
    fillRequired();
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finish({ ok: true, json: async () => ({ ok: true }) });
    await screen.findByText("Request received");
  });

  it("sends the category for the chosen use case", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const { container } = render(<DemoForm initialUseCase="team-training" />);
    fillRequired();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText("Request received");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      category: "team-training",
      useCase: "team-training",
      companyName: "Acme",
    });
  });

  it("clears a field's error once the field is edited and keeps the others", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({
        error: "Please correct the highlighted fields.",
        fieldErrors: {
          email: ["Enter a valid email address"],
          message: ["Message is required"],
        },
      }),
    });
    const { container } = render(<DemoForm initialUseCase="" />);
    fillRequired();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    await screen.findByText("Enter a valid email address");
    expect(screen.getByText("Message is required")).toBeTruthy();

    fill("Work email", "asha@acme.co");
    await waitFor(() =>
      expect(screen.queryByText("Enter a valid email address")).toBeNull(),
    );
    expect(
      screen.queryByText("Please correct the highlighted fields."),
    ).toBeNull();
    expect(screen.getByText("Message is required")).toBeTruthy();
  });
});
