import test from "node:test";
import assert from "node:assert/strict";
import { sseResponse } from "../src/lib/sse.js";

test("frames are named events with JSON data", async () => {
  const res = sseResponse(
    async (emit) => {
      emit("status", { phase: "triage" });
      emit("sources", { items: [{ title: "A", url: "https://a.gov" }] });
      emit("delta", { text: "hi" });
      emit("done", { auditId: "abc", mode: "audit" });
    },
    { origin: "https://i-nspired.example" }
  );

  const text = await res.text();

  assert.ok(text.includes('event: delta\ndata: {"text":"hi"}\n\n'));
  assert.ok(text.includes("event: done\n"));
  assert.equal(res.headers.get("access-control-allow-origin"), "https://i-nspired.example");
  assert.equal(res.headers.get("cache-control"), "no-store, no-transform");
  assert.ok(text.endsWith("\n\n"));
});

test("a thrown error becomes a terminal error frame, not a truncated stream", async () => {
  const res = sseResponse(async (emit) => {
    emit("delta", { text: "partial" });
    throw new Error("upstream died");
  });

  const text = await res.text();

  assert.ok(text.includes("event: error\n"));
  assert.ok(text.includes("upstream died"));
  assert.ok(text.endsWith("\n\n"));
});

test("no origin means no CORS header, rather than a wildcard", async () => {
  const res = sseResponse(async (emit) => emit("delta", { text: "x" }));
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
