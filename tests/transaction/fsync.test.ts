import { expect, it } from "vitest";
import { fileFsyncOpenMode, persistDirectory } from "../../src/core/transaction/fsync.js";

it("opens files with write access for Windows FlushFileBuffers", () => {
  expect(fileFsyncOpenMode("win32")).toBe("r+");
  expect(fileFsyncOpenMode("linux")).toBe("r");
});

it("does not attempt unsupported directory fsync on Windows", () => {
  expect(() => persistDirectory("path-does-not-need-to-exist", "win32")).not.toThrow();
});

it("fails closed when a POSIX directory cannot be opened", () => {
  expect(() => persistDirectory("path-does-not-exist", "linux")).toThrow();
});
