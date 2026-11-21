/**
 * A module whose every export is one async no-op answering `answer` (`[]` by
 * default), for a `jest.mock` factory that silences an edge (Novu, email) in
 * the database tier.
 */
export function noopModule(answer: unknown = []): object {
  const noop = jest.fn(async () => answer);
  return new Proxy(
    {},
    {
      // Not a thenable, so a dynamic import of the mocked module resolves.
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
}
