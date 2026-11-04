/**
 * A module whose every export is one async no-op answering `[]`, for a
 * `jest.mock` factory that silences an edge (Novu) in the database tier.
 */
export function noopModule(): object {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
}
