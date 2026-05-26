/**
 * React hook around the v2 workflows run service.
 *
 * Provides a minimal imperative API for components that want to start a run,
 * collect typed AG-UI events as they arrive, and abort. Currently has no
 * in-tree consumers; the canvas drives runs through ``runFlowAGUI``
 * directly. Kept here so a future component that wants to consume a typed
 * event stream can drop in without re-deriving the lifecycle.
 */

import { type BaseEvent } from "@ag-ui/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Subscription } from "rxjs";
import {
  buildWorkflowRunRequest,
  createWorkflowAgent,
  type WorkflowAgentOptions,
  type WorkflowHttpAgent,
  type WorkflowRunOptions,
} from "./run-agent";

export interface UseRunFlowState {
  /** All AG-UI events received so far in the current run. */
  events: BaseEvent[];
  /** True from the moment a run is started until it ends (success or error). */
  isRunning: boolean;
  /** Error from a failed run; cleared at the start of the next run. */
  error: Error | null;
}

const INITIAL_STATE: UseRunFlowState = {
  events: [],
  isRunning: false,
  error: null,
};

/** Construction overrides accepted by the hook (omits the per-run body). */
export type UseRunFlowAgentOptions = Omit<WorkflowAgentOptions, "body">;

/**
 * Run v2 workflows from React.
 *
 * A fresh `WorkflowHttpAgent` is built per run because the native body is
 * bound at construction time. Calling `run` again starts a new run
 * (resetting `events`); `abort` stops the active run.
 */
export function useRunFlow(agentOptions: UseRunFlowAgentOptions = {}) {
  const agentRef = useRef<WorkflowHttpAgent | null>(null);
  const subRef = useRef<Subscription | null>(null);
  // The active run's resolver. Held so ``abort`` and a preempting ``run``
  // can settle the previous Promise instead of leaving callers awaiting
  // forever when the observable doesn't emit ``error``/``complete`` for
  // the cancelled path.
  const resolveRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<UseRunFlowState>(INITIAL_STATE);

  const run = useCallback(
    (opts: WorkflowRunOptions) =>
      new Promise<void>((resolve) => {
        // Cancel any prior in-flight run. ``abortRun`` aborts the previous
        // agent's AbortController; without it the previous fetch is
        // orphaned (unsubscribe only detaches the local RxJS subscriber)
        // and keeps draining bytes until the server closes the connection.
        // Also settle the prior Promise so its callers don't deadlock.
        resolveRef.current?.();
        subRef.current?.unsubscribe();
        agentRef.current?.abortRun();
        resolveRef.current = resolve;
        setState({ events: [], isRunning: true, error: null });

        const body = buildWorkflowRunRequest(opts);
        const agent = createWorkflowAgent({ ...agentOptions, body });
        agentRef.current = agent;

        // `agent.run` needs a `RunAgentInput` for the client-side apply
        // pipeline; the wire body is the native `WorkflowRunRequest` set
        // on the agent. These ids stay local — the server announces its
        // own run/thread ids via the typed event stream.
        const runInput = {
          threadId: opts.threadId ?? "",
          runId: "",
          state: {},
          messages: [],
          tools: [],
          context: [],
          forwardedProps: {},
        };

        const settle = () => {
          if (resolveRef.current === resolve) {
            resolveRef.current = null;
          }
          resolve();
        };

        subRef.current = agent.run(runInput).subscribe({
          next: (event) => {
            setState((s) => ({ ...s, events: [...s.events, event] }));
          },
          error: (err: Error) => {
            setState((s) => ({ ...s, isRunning: false, error: err }));
            settle();
          },
          complete: () => {
            setState((s) => ({ ...s, isRunning: false }));
            settle();
          },
        });
      }),
    [agentOptions],
  );

  const abort = useCallback(() => {
    subRef.current?.unsubscribe();
    agentRef.current?.abortRun();
    setState((s) => ({ ...s, isRunning: false }));
    // ``abortRun`` synchronously stops the SSE fetch, but the RxJS
    // subscriber won't fire ``error``/``complete`` for that path. Resolve
    // the run Promise here so callers awaiting ``run()`` aren't stuck.
    resolveRef.current?.();
    resolveRef.current = null;
  }, []);

  // If the host component unmounts mid-run, tear down the SSE fetch and
  // settle any pending ``run()`` Promise. Without this, ``abortRun`` is
  // never called and the fetch keeps streaming server-side; the RxJS
  // subscriber would also call ``setState`` on an unmounted component.
  useEffect(
    () => () => {
      subRef.current?.unsubscribe();
      agentRef.current?.abortRun();
      resolveRef.current?.();
      resolveRef.current = null;
    },
    [],
  );

  return { ...state, run, abort };
}
