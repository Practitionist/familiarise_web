/** One moved session of a series: its old start and its new start. */
export type SessionMove = { from: Date | string; to: Date | string };

/** A series-move notice lists at most this many sessions, then "and N more". */
export const MOVES_SHOWN = 10;

/** The moves a notice lists, and how many it leaves to "and N more". */
export function shownMoves<T>(moves: readonly T[]): {
  shown: T[];
  more: number;
} {
  return {
    shown: moves.slice(0, MOVES_SHOWN),
    more: Math.max(0, moves.length - MOVES_SHOWN),
  };
}
