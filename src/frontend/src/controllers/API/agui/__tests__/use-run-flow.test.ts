/**
 * Tests for the useRunFlow hook lifecycle.
 *
 * Pins the contract that calling `run` while a previous run is still in
 * flight aborts the previous AbortController, not just the local RxJS
 * subscriber. Without that, the previous HTTP request keeps draining
 * server-side bytes until the server closes the connection.
 */

import { act, renderHook } from "@testing-library/react";
import { useRunFlow } from "@/controllers/API/agui/use-run-flow";

beforeAll(() => {
  const g = global as {
    fetch?: unknown;
    TextEncoder?: unknown;
    TextDecoder?: unknown;
  };
  const util = require("util") as {
    TextEncoder: typeof TextEncoder;
    TextDecoder: typeof TextDecoder;
  };
  if (typeof g.TextEncoder !== "function") g.TextEncoder = util.TextEncoder;
  if (typeof g.TextDecoder !== "function") g.TextDecoder = util.TextDecoder;
  if (typeof g.fetch !== "function") {
    g.fetch = () => Promise.reject(new Error("fetch not stubbed"));
  }
});

/**
 * Fake fetch that records every AbortSignal it sees and returns a Response
 * whose body reader hangs forever. Lets the test observe that the previous
 * run's signal is aborted when a new run starts.
 */
function makeHangingFetch() {
  const signals: AbortSignal[] = [];
  const fetchImpl = (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.signal) signals.push(init.signal);
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get(key: string) {
          return key.toLowerCase() === "content-type"
            ? "text/event-stream"
            : null;
        },
      },
      body: {
        getReader() {
          return {
            read: () => new Promise(() => {}),
            cancel: async () => {},
          };
        },
      },
      text: async () => "",
    } as unknown as Response);
  };
  return { signals, fetchImpl };
}

describe("useRunFlow concurrency", () => {
  it("aborts the previous run's fetch when run is called again", async () => {
    const { signals, fetchImpl } = makeHangingFetch();
    const fetchSpy = jest
      .spyOn(global as { fetch: typeof fetch }, "fetch")
      .mockImplementation(fetchImpl as unknown as typeof fetch);

    try {
      const { result } = renderHook(() => useRunFlow());

      // First run: kicks off a fetch that hangs forever.
      await act(async () => {
        result.current.run({
          flowId: "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
          message: "first",
        });
        // Yield so the agent.run subscription wires up and fetch is called.
        await Promise.resolve();
      });
      expect(signals.length).toBe(1);
      expect(signals[0].aborted).toBe(false);

      // Second run starts while the first is still in flight.
      await act(async () => {
        result.current.run({
          flowId: "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
          message: "second",
        });
        await Promise.resolve();
      });

      expect(signals.length).toBe(2);
      // The first signal must be aborted now; otherwise the previous fetch
      // is orphaned and keeps streaming server-side until the server closes.
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("settles the run Promise when abort() is called mid-stream", async () => {
    /**
     * Without this, an awaited ``run()`` whose stream is then aborted would
     * never resolve. The RxJS subscriber doesn't fire error/complete for
     * the abort path, so the caller deadlocks.
     */
    const { fetchImpl } = makeHangingFetch();
    const fetchSpy = jest
      .spyOn(global as { fetch: typeof fetch }, "fetch")
      .mockImplementation(fetchImpl as unknown as typeof fetch);

    try {
      const { result } = renderHook(() => useRunFlow());

      let runResolved = false;
      let runPromise: Promise<void> = Promise.resolve();
      await act(async () => {
        runPromise = result.current
          .run({
            flowId: "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
            message: "hang",
          })
          .then(() => {
            runResolved = true;
          });
        await Promise.resolve();
      });
      expect(runResolved).toBe(false);

      await act(async () => {
        result.current.abort();
      });
      await runPromise;

      expect(runResolved).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("settles the previous run Promise when a new run preempts it", async () => {
    const { fetchImpl } = makeHangingFetch();
    const fetchSpy = jest
      .spyOn(global as { fetch: typeof fetch }, "fetch")
      .mockImplementation(fetchImpl as unknown as typeof fetch);

    try {
      const { result } = renderHook(() => useRunFlow());

      let firstResolved = false;
      let firstPromise: Promise<void> = Promise.resolve();
      await act(async () => {
        firstPromise = result.current
          .run({
            flowId: "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
            message: "first",
          })
          .then(() => {
            firstResolved = true;
          });
        await Promise.resolve();
      });
      expect(firstResolved).toBe(false);

      await act(async () => {
        result.current.run({
          flowId: "67ccd2be-17f0-8190-81ff-3bb2cf6508e6",
          message: "second",
        });
        await Promise.resolve();
      });
      await firstPromise;

      expect(firstResolved).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
