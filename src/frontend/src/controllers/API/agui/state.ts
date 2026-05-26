/**
 * Canvas-state reducer for AG-UI `STATE_SNAPSHOT` and `STATE_DELTA` events.
 *
 * The backend's `AGUITranslator` seeds the run with an empty
 * `{nodes: {}}` snapshot, then drives per-vertex updates as `STATE_DELTA`s
 * carrying `add` ops on `/nodes/{id}`. This reducer applies those updates to
 * produce the node-state map the canvas renders. Pure — no React, no store.
 */

import { type BaseEvent, EventType } from "@ag-ui/client";

/** Lifecycle status reported for a node by the run. */
export type CanvasNodeStatus = "pending" | "running" | "success" | "error";

/** State of a single node on the canvas during/after a run. */
export interface CanvasNodeState {
  status: CanvasNodeStatus;
  output: unknown;
}

/** Top-level run state the canvas/playground consumes. */
export interface CanvasState {
  nodes: Record<string, CanvasNodeState>;
}

/** Initial state at the start of a run, before any events arrive. */
export const INITIAL_CANVAS_STATE: CanvasState = { nodes: {} };

interface JsonPatchOp {
  op: string;
  path: string;
  value?: unknown;
}

const NODE_PATH = /^\/nodes\/([^/]+)$/;

/**
 * Apply one RFC 6902 op to the canvas state. Supports only the shapes the
 * Langflow translator emits today: `add`/`replace` on `/nodes/{id}`. Anything
 * else is ignored (rather than throwing) so an unexpected payload cannot
 * crash the run.
 */
function applyOp(state: CanvasState, op: JsonPatchOp): CanvasState {
  const match = NODE_PATH.exec(op.path);
  if (!match) return state;
  if (op.op !== "add" && op.op !== "replace") return state;
  const nodeId = match[1];
  return {
    ...state,
    nodes: { ...state.nodes, [nodeId]: op.value as CanvasNodeState },
  };
}

/**
 * Reduce one AG-UI event into the canvas state.
 *
 * `STATE_SNAPSHOT` replaces the entire state with its `snapshot`. `STATE_DELTA`
 * applies each op in order. Every other event leaves the state untouched.
 */
export function applyAGUIStateEvent(
  state: CanvasState,
  event: BaseEvent,
): CanvasState {
  if (event.type === EventType.STATE_SNAPSHOT) {
    const snapshot = (event as unknown as { snapshot: unknown }).snapshot;
    const nodes = (snapshot as { nodes?: unknown } | null)?.nodes;
    if (
      snapshot &&
      typeof snapshot === "object" &&
      nodes !== null &&
      typeof nodes === "object" &&
      !Array.isArray(nodes)
    ) {
      return snapshot as CanvasState;
    }
    return state;
  }
  if (event.type === EventType.STATE_DELTA) {
    // ``delta`` should be a JSON-Patch array but malformed payloads could send
    // null, an object, or a string. Anything that isn't an array is a no-op
    // — calling ``reduce`` on it would crash the run.
    const raw = (event as unknown as { delta?: unknown }).delta;
    const ops = Array.isArray(raw) ? (raw as JsonPatchOp[]) : [];
    return ops.reduce(applyOp, state);
  }
  return state;
}
