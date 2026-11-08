/**
 * @jest-environment node
 */

/**
 * The workflow sync writes every family always-on and read-only, and treats
 * subscriber-editable live preferences or a leftover step condition as drift.
 */

// humanize.ts reaches prisma for recipient timezones; nothing here does.
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import type {
  UpdateWorkflowDto,
  WorkflowResponseDto,
} from "@novu/api/models/components";
import { FAMILIES, toFamilyDto } from "@/lib/novu/templates";
import { apply, diff } from "@/scripts/novu/sync-workflows";

const family = FAMILIES.find((f) => f.id === "support-ticket")!;
const want = toFamilyDto(family);
const readOnly = {
  all: { enabled: true, readOnly: true },
  channels: { in_app: { enabled: true } },
};

/** A live workflow that matches the manifest, with overrides. */
function liveWorkflow(
  overrides: {
    preferences?: WorkflowResponseDto["preferences"];
    controls?: Record<string, unknown>;
  } = {},
): WorkflowResponseDto {
  const step = want.steps[0] as { controlValues: Record<string, unknown> };
  return {
    name: want.name,
    active: true,
    description: want.description,
    tags: want.tags,
    workflowId: want.workflowId,
    preferences: overrides.preferences ?? {
      user: readOnly,
      default: readOnly,
    },
    steps: [
      {
        id: "step-1",
        stepId: "in-app",
        type: "in_app",
        controlValues: { ...step.controlValues, ...overrides.controls },
      },
    ],
  } as unknown as WorkflowResponseDto;
}

describe("sync-workflows", () => {
  it("sees no drift on a live family that already matches", () => {
    expect(diff(liveWorkflow(), want)).toEqual([]);
  });

  it("flags subscriber-editable live preferences", () => {
    const editable = {
      all: { enabled: true, readOnly: false },
      channels: { in_app: { enabled: true } },
    };
    expect(
      diff(
        liveWorkflow({ preferences: { user: editable, default: editable } }),
        want,
      ),
    ).toEqual(["preferences"]);
    expect(
      diff(liveWorkflow({ preferences: { default: editable } }), want),
    ).toEqual(["preferences"]);
  });

  it("flags a leftover step condition", () => {
    const skip = { and: [{ "!=": [{ var: "subscriber.data.x" }, "false"] }] };
    expect(diff(liveWorkflow({ controls: { skip } }), want)).toEqual([
      "in_app.skip",
    ]);
  });

  it("updates with the manifest's read-only preferences, keeping the live step id", async () => {
    const editable = {
      all: { enabled: false, readOnly: false },
      channels: { in_app: { enabled: false } },
    };
    const live = liveWorkflow({
      preferences: { user: editable, default: editable },
      controls: { skip: { and: [] } },
    });
    const update = jest.fn(async (_dto: UpdateWorkflowDto, _id: string) => ({
      result: live,
    }));
    const novu = {
      workflows: {
        get: jest.fn(async () => ({ result: live })),
        update,
        create: jest.fn(),
        delete: jest.fn(),
      },
    };

    await apply(
      novu as unknown as Parameters<typeof apply>[0],
      { action: "update", id: want.workflowId, changed: ["preferences"] },
      want,
    );

    expect(update).toHaveBeenCalledTimes(1);
    const [dto, id] = update.mock.calls[0];
    expect(id).toBe(want.workflowId);
    expect(dto.preferences).toEqual({ user: readOnly, workflow: readOnly });
    const step = dto.steps[0] as {
      id?: string;
      controlValues: Record<string, unknown>;
    };
    expect(step.id).toBe("step-1");
    expect(step.controlValues).not.toHaveProperty("skip");
  });
});
