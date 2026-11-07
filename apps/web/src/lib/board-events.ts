import { isRetryableError, retryDelayMs } from "@rakazo/core";
import { useEffect, useRef } from "react";
import { rpc } from "./rpc";

export type BoardEventHandlers = {
  /** The stream is open: read anything that may have changed while it was not. */
  onOpen?: () => Promise<void> | void;
  onEvent: (event: { ticketId?: string }) => Promise<void> | void;
  /** A failure ended the stream; retryable ones reconnect after a delay. */
  onError?: (cause: unknown) => void;
};

/**
 * Follows the space's ticket-change stream, reconnecting after retryable failures. Screens
 * keep their own polling as a fallback, since a change made while disconnected is not replayed.
 */
export function useBoardEvents(handlers: BoardEventHandlers, scope: unknown): void {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    let currentController: AbortController | undefined;
    let active = true;
    let cancelRetry: (() => void) | undefined;
    void (async () => {
      while (active) {
        const controller = new AbortController();
        currentController = controller;
        let failure: unknown;
        try {
          const stream = await rpc.boards.subscribe(undefined, { signal: controller.signal });
          if (!active) return;
          await current.current.onOpen?.();
          if (!active) return;
          for await (const event of stream) {
            if (!active) return;
            await current.current.onEvent(event);
          }
        } catch (cause) {
          failure = cause;
          if (active) current.current.onError?.(cause);
        } finally {
          controller.abort();
        }
        if (!active || !isRetryableError(failure)) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs(failure, 1_000));
          cancelRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        cancelRetry = undefined;
      }
    })();
    return () => {
      active = false;
      currentController?.abort();
      cancelRetry?.();
    };
  }, [scope]);
}
