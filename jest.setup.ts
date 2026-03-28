import "@testing-library/jest-dom";

// Suppress console.error/warn noise from code paths that intentionally throw
// (auth rejections, validation failures, missing mocks). Tests that need to
// assert on console output can spy on these individually.
beforeAll(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});
