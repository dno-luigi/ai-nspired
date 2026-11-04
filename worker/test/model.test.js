import test from "node:test";
import assert from "node:assert/strict";
import { parseDeltaStream, streamChat, authorLabel } from "../src/lib/model.js";

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

test("a JSON frame split across chunks is reassembled", async () => {
  const body = streamOf([
    'data: {"choices":[{"delta":{"content":"Hel',
    'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    "data: [DONE]\n\n"
  ]);

  const out = [];
  for await (const chunk of parseDeltaStream(body)) out.push(chunk);

  assert.deepEqual(out, [{ delta: "Hello" }, { delta: " world" }]);
});

test("usage is surfaced and a trailing frame with no newline still lands", async () => {
  const body = streamOf([
    'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"total_tokens":9}}'
  ]);

  const out = [];
  for await (const chunk of parseDeltaStream(body)) out.push(chunk);

  assert.deepEqual(out, [{ delta: "ok" }, { usage: { total_tokens: 9 } }]);
});

test("an upstream error frame throws instead of silently ending", async () => {
  const body = streamOf(['data: {"error":{"message":"rate limited"}}\n\n']);

  await assert.rejects(async () => {
    for await (const _ of parseDeltaStream(body)) {
      /* drain */
    }
  }, /rate limited/);
});

test("the workersai backend routes through env.AI and names itself", async () => {
  const env = {
    MODEL_BACKEND: "workersai",
    WORKERS_AI_MODEL: "@cf/meta/llama",
    AI: {
      run: async () =>
        streamOf([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
          "data: [DONE]\n\n"
        ])
    }
  };

  assert.equal(authorLabel(env), "@cf/meta/llama");

  const out = [];
  for await (const chunk of streamChat({ messages: [], env })) out.push(chunk);
  assert.deepEqual(out, [{ delta: "hi" }]);
});

test("openrouter refuses to run without a key", async () => {
  await assert.rejects(async () => {
    for await (const _ of streamChat({ messages: [], env: { CF_ACCOUNT_ID: "abc" } })) {
      /* drain */
    }
  }, /OPENROUTER_API_KEY/);
});

test("a placeholder account id is treated as unconfigured", async () => {
  await assert.rejects(async () => {
    for await (const _ of streamChat({
      messages: [],
      env: { OPENROUTER_API_KEY: "k", CF_ACCOUNT_ID: "REPLACE_WITH_ACCOUNT_ID" }
    })) {
      /* drain */
    }
  }, /CF_ACCOUNT_ID/);
});
