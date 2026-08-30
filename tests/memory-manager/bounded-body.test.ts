import { expect, it, vi } from "vitest";
import { readBoundedBody } from "../../src/memory-manager/openai/bounded-body.js";

it("cancels response bodies rejected by Content-Length", async () => {
  const cancel = vi.fn(); const response = { headers: new Headers({ "content-length": "101" }), body: { cancel } } as unknown as Response;
  await expect(readBoundedBody(response, 100)).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(cancel).toHaveBeenCalledOnce();
});
it("cancels a locked reader after chunk overflow", async () => {
  const cancel = vi.fn(async () => undefined); const releaseLock = vi.fn(); const read = vi.fn(async () => ({ done: false, value: new Uint8Array(101) }));
  const response = { headers: new Headers(), body: { getReader: () => ({ read, cancel, releaseLock }) } } as unknown as Response;
  await expect(readBoundedBody(response, 100)).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(cancel).toHaveBeenCalledOnce(); expect(releaseLock).toHaveBeenCalledOnce();
});
