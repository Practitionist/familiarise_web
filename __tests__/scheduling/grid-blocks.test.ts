import { buildGridBlocks, type BlockCell } from "@/lib/scheduling/grid-blocks";
import type { SlotStatusKey } from "@/lib/scheduling/interval-status-tokens";

const ATOM = 30 * 60 * 1000;
/** Wed 12 Jun 2030 10:00 UTC. */
const T0 = Date.UTC(2030, 5, 12, 10, 0);

function cell(
  startMs: number,
  statusKey: SlotStatusKey,
  extra: Partial<BlockCell> = {},
): BlockCell {
  return {
    startMs,
    endMs: startMs + ATOM,
    statusKey,
    stateLabel: statusKey,
    isRequested: false,
    overlapping: [],
    ...extra,
  };
}

/** One column: `cells[i]` sits on axis row i of day 0. */
function column(cells: (BlockCell | null)[]): (BlockCell | null)[][] {
  return cells.map((entry) => [entry]);
}

const booking = (id: string, title: string) => ({
  overlapping: [{ id, type: "Consultation", title }],
});

describe("buildGridBlocks", () => {
  it("merges a contiguous same-state run into one block labelled by its booking", () => {
    const blocks = buildGridBlocks(
      column([
        cell(T0 - ATOM, "available"),
        cell(T0, "fullyBooked", booking("a", "Spanish B1")),
        cell(T0 + ATOM, "fullyBooked", booking("a", "Spanish B1")),
        cell(T0 + 2 * ATOM, "fullyBooked", booking("a", "Spanish B1")),
        cell(T0 + 3 * ATOM, "available"),
      ]),
      "UTC",
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      dayIndex: 0,
      fromRow: 1,
      toRow: 4,
      startMs: T0,
      endMs: T0 + 3 * ATOM,
      statusKey: "fullyBooked",
      label: "Spanish B1",
    });
    expect(blocks[0].timeLabel).toMatch(/^10:00.*–11:30/);
  });

  it("keeps a single atom as its own block, labelled by its state", () => {
    const [block] = buildGridBlocks(
      column([cell(T0, "selected", { stateLabel: "Selected" })]),
      "UTC",
    );
    expect(block).toMatchObject({ fromRow: 0, toRow: 1, label: "Selected" });
  });

  it("splits back-to-back bookings, state changes and requested edges", () => {
    const blocks = buildGridBlocks(
      column([
        cell(T0, "fullyBooked", booking("a", "A")),
        cell(T0 + ATOM, "fullyBooked", booking("b", "B")),
        cell(T0 + 2 * ATOM, "selected", { isRequested: true }),
        cell(T0 + 3 * ATOM, "selected"),
        cell(T0 + 4 * ATOM, "thisEvent"),
      ]),
      "UTC",
    );
    expect(blocks.map((b) => [b.fromRow, b.toRow, b.label])).toEqual([
      [0, 1, "A"],
      [1, 2, "B"],
      [2, 3, "selected"],
      [3, 4, "selected"],
      [4, 5, "thisEvent"],
    ]);
    expect(blocks[2].isRequested).toBe(true);
  });

  it("draws no block for per-cell states", () => {
    expect(
      buildGridBlocks(
        column([
          cell(T0, "available"),
          cell(T0 + ATOM, "tooSoon"),
          cell(T0 + 2 * ATOM, "limitReached"),
          cell(T0 + 3 * ATOM, "unavailable"),
        ]),
        "UTC",
      ),
    ).toEqual([]);
  });

  it("splits a run at local midnight in the zone it is given", () => {
    // 18:00 and 18:30 UTC are 23:30 and 00:00 in Kolkata: two calendar days.
    const lateEvening = Date.UTC(2030, 5, 12, 18, 0);
    const matrix = column([
      cell(lateEvening, "selected"),
      cell(lateEvening + ATOM, "selected"),
    ]);
    expect(buildGridBlocks(matrix, "Asia/Kolkata")).toHaveLength(2);
    expect(buildGridBlocks(matrix, "UTC")).toHaveLength(1);
  });

  it("spans rows a clock change skips when the atoms are contiguous in time", () => {
    const blocks = buildGridBlocks(
      column([
        cell(T0, "thisEvent"),
        null,
        null,
        cell(T0 + ATOM, "thisEvent"),
        null,
        cell(T0 + 5 * ATOM, "thisEvent"),
      ]),
      "UTC",
    );
    expect(blocks.map((b) => [b.fromRow, b.toRow])).toEqual([
      [0, 4],
      [5, 6],
    ]);
  });

  it("builds each day column on its own", () => {
    const blocks = buildGridBlocks(
      [
        [cell(T0, "selected"), cell(T0 + 86_400_000, "selected")],
        [cell(T0 + ATOM, "selected"), null],
      ],
      "UTC",
    );
    expect(blocks.map((b) => [b.dayIndex, b.fromRow, b.toRow])).toEqual([
      [0, 0, 2],
      [1, 0, 1],
    ]);
  });
});
