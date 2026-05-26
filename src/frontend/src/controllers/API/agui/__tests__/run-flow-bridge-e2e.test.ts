/**
 * End-to-end tests for the AG-UI bridge: drive `runFlowAGUI` against a
 * synthetic SSE stream and assert side effects on the real `flowStore` +
 * `alertStore` singletons. The unit tests in `run-flow-bridge.test.ts`
 * only cover the event-dispatch return-value contract, so this file
 * pins the integration: a realistic event sequence has to leave the
 * canvas in the expected resolved state (or surface the error to the
 * alert store on RUN_ERROR).
 */

import { BuildStatus } from "@/constants/enums";
import { runFlowAGUI } from "@/controllers/API/agui/run-flow-bridge";
import useAlertStore from "@/stores/alertStore";
import useFlowStore from "@/stores/flowStore";
import { useMessagesStore } from "@/stores/messagesStore";

beforeAll(() => {
  // jsdom lacks the codecs the AG-UI SSE decoder uses; pull them from
  // node's `util` exactly as `run-agent.test.ts` does.
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

beforeEach(() => {
  // Reset only the slices the bridge writes to. Touching the full state
  // would clobber action implementations (Zustand stores actions in the
  // same state object).
  useFlowStore.setState({
    flowBuildStatus: {},
    flowPool: {},
    isBuilding: true,
    buildInfo: null,
  });
  useAlertStore.setState({
    errorData: { title: "", list: [] },
    notificationList: [],
    tempNotificationList: [],
  });
  // The CUSTOM(langflow.event, add_message) branch routes through
  // ``handleMessageEvent``, which appends to ``useMessagesStore``. Clearing
  // here keeps the assertion below honest across reruns.
  useMessagesStore.setState({ messages: [] });
});

// Minimal fake Response sufficient for `runHttpRequest`'s SSE decoder.
// Lifted from the pattern in `run-agent.test.ts` so the bridge sees
// exactly what the wire produces.
function sseResponse(events: object[]): unknown {
  const encoder = new (
    globalThis as { TextEncoder: typeof TextEncoder }
  ).TextEncoder();
  const payload = encoder.encode(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
  );
  let delivered = false;
  return {
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
          async read() {
            if (delivered) return { done: true, value: undefined };
            delivered = true;
            return { done: false, value: payload };
          },
          async cancel() {
            /* no-op */
          },
        };
      },
    },
    text: async () => "",
  };
}

describe("runFlowAGUI end-to-end", () => {
  it("folds a full RUN_STARTED → STATE_DELTA → RUN_FINISHED stream into flowStore", async () => {
    const events = [
      {
        type: "RUN_STARTED",
        threadId: "thread-1",
        runId: "run-1",
        timestamp: 0,
      },
      {
        type: "STATE_SNAPSHOT",
        snapshot: { nodes: {} },
        timestamp: 0,
      },
      {
        type: "STATE_DELTA",
        delta: [
          {
            op: "add",
            path: "/nodes/node-a",
            value: { status: "running", output: null },
          },
        ],
        timestamp: 0,
      },
      {
        type: "STATE_DELTA",
        delta: [
          {
            op: "replace",
            path: "/nodes/node-a",
            value: {
              status: "success",
              output: { results: { text: "hello" } },
            },
          },
        ],
        timestamp: 0,
      },
      {
        type: "CUSTOM",
        name: "langflow.event",
        value: {
          event_type: "add_message",
          data: {
            id: "msg-1",
            text: "hello from agent",
            sender: "AI",
            sender_name: "agent",
            session_id: "thread-1",
          },
        },
        timestamp: 0,
        rawEvent: {},
      },
      {
        type: "RUN_FINISHED",
        threadId: "thread-1",
        runId: "run-1",
        timestamp: 0,
      },
    ];

    const fetchSpy = jest
      .spyOn(global as { fetch: typeof fetch }, "fetch")
      .mockImplementation((async () =>
        sseResponse(events)) as unknown as typeof fetch);

    try {
      await runFlowAGUI({
        flowId: "flow-1",
        message: "hi",
        threadId: "thread-1",
      });

      const flow = useFlowStore.getState();
      expect(flow.isBuilding).toBe(false);
      expect(flow.buildInfo).toEqual({ success: true });
      // Final delta carries a real output, so the flow pool gets the entry
      // stamped with the runId server announced via RUN_STARTED.
      expect(flow.flowPool["node-a"]).toHaveLength(1);
      expect(flow.flowPool["node-a"][0]).toMatchObject({
        id: "node-a",
        run_id: "run-1",
        valid: true,
      });
      // `revertBuiltStatusFromBuilding` is called after the run, but the
      // final status here came in as `success` already so it stays BUILT.
      expect(flow.flowBuildStatus["node-a"]?.status).toBe(BuildStatus.BUILT);
      // The CUSTOM(langflow.event) frame was routed through
      // ``handleMessageEvent``, which appended to ``useMessagesStore``.
      // Pinning the side effect proves the bridge dispatch actually wires
      // a realistic ``event_type`` through to the chat-view handler, not
      // just an inert pass-through.
      const messages = useMessagesStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ id: "msg-1", sender: "AI" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("surfaces RUN_ERROR to alertStore and clears isBuilding", async () => {
    const events = [
      {
        type: "RUN_STARTED",
        threadId: "thread-1",
        runId: "run-1",
        timestamp: 0,
      },
      {
        type: "RUN_ERROR",
        message: "graph blew up",
        timestamp: 0,
      },
    ];

    const fetchSpy = jest
      .spyOn(global as { fetch: typeof fetch }, "fetch")
      .mockImplementation((async () =>
        sseResponse(events)) as unknown as typeof fetch);

    try {
      await runFlowAGUI({ flowId: "flow-1", message: "boom" });

      const flow = useFlowStore.getState();
      const alert = useAlertStore.getState();
      expect(flow.isBuilding).toBe(false);
      expect(flow.buildInfo).toEqual({
        error: ["graph blew up"],
        success: false,
      });
      expect(alert.errorData.title).toBe("Workflow run failed");
      expect(alert.errorData.list).toEqual(["graph blew up"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
