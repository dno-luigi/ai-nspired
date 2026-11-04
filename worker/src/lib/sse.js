const encoder = new TextEncoder();

/**
 * The whole point of this module: the Worker owns the wire format instead of
 * piping a vendor body through. Frames are:
 *
 *   event: status   data: { phase, detail? }
 *   event: sources  data: { items: [{ title, url }] }
 *   event: delta    data: { text }
 *   event: done     data: { auditId, mode, usage? }
 *   event: error    data: { code, message }
 *
 * `run` receives an emit function and an abort signal. A thrown error becomes
 * a final `error` frame rather than a truncated stream, so the client always
 * gets a clean terminal state.
 */
export function sseResponse(run, { origin = null, onCancel = null } = {}) {
  let cancelled = false;
  const abort = new AbortController();

  const body = new ReadableStream({
    async start(controller) {
      const emit = (event, data) => {
        if (cancelled) return false;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
          return true;
        } catch {
          // Enqueue after close: the client went away mid-frame.
          cancelled = true;
          return false;
        }
      };

      try {
        await run(emit, abort.signal);
      } catch (err) {
        const code = err?.code || "stream_error";
        const message = err?.expose === false ? "Generation failed" : err?.message || "Generation failed";
        console.error("sse_run_failed", { code, message: err?.message, stack: err?.stack });
        emit("error", { code, message });
      } finally {
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      cancelled = true;
      abort.abort();
      if (onCancel) onCancel();
    }
  });

  const headers = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    // Belt and braces against intermediate buffering.
    "x-accel-buffering": "no"
  };
  if (origin) headers["access-control-allow-origin"] = origin;

  return new Response(body, { headers });
}
