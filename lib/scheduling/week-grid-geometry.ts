/**
 * The week grid's column template, shared by the grid and its loading
 * skeleton. A plain module so server-rendered skeletons can import it.
 */

/** A fixed time gutter and seven shrinkable day columns. */
export const GRID_COLS =
  "grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] md:grid-cols-[5rem_repeat(7,minmax(0,1fr))]";
