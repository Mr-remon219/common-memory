import { expect, it } from "vitest";
import { persistDirectory } from "../../src/core/transaction/fsync.js";

it("does not attempt unsupported directory fsync on Windows", () => {
  expect(() => persistDirectory("path-does-not-need-to-exist", "win32")).not.toThrow();
});

it("fails closed when a POSIX directory cannot be opened", () => {
  expect(() => persistDirectory("path-does-not-exist", "linux")).toThrow();
});
