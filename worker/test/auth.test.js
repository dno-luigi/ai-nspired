import test from "node:test";
import assert from "node:assert/strict";
import { assertSameOrigin, matchOrigin, safeEqual } from "../src/lib/http.js";
import { requireKey, enforceDailyLimit } from "../src/lib/auth.js";

const req = (headers = {}) => ({ headers: new Headers(headers) });
const env = { ALLOWED_ORIGINS: "https://i-nspired.example,https://ai-n.org" };

test("origin matching is exact string equality", () => {
  assert.equal(matchOrigin(req({ origin: "https://i-n.org" }), env), null);
  assert.equal(matchOrigin(req({ origin: "https://ai-n.org" }), env), "https://ai-n.org");
  assert.equal(matchOrigin(req(), env), null);
});

test("a mutation with no Origin or a foreign Origin is rejected", () => {
  assert.throws(
    () => assertSameOrigin(req(), env),
    (err) => err.status === 403 && err.code === "origin_missing"
  );
  assert.throws(
    () => assertSameOrigin(req({ origin: "https://evil.example" }), env),
    (err) => err.status === 403 && err.code === "origin_rejected"
  );
  assert.doesNotThrow(() => assertSameOrigin(req({ origin: "https://ai-n.org" }), env));
});

test("the engine key gate fails closed", () => {
  assert.throws(
    () => requireKey(req({ "x-engine-key": "x" }), {}),
    (err) => err.status === 503
  );
  assert.throws(
    () => requireKey(req({ "x-engine-key": "wrong" }), { KEY: "right" }),
    (err) => err.status === 401
  );
  assert.doesNotThrow(() => requireKey(req({ "x-engine-key": "right" }), { KEY: "right" }));
});

test("the daily cap counts, rejects past the limit, and 0 disables it", async () => {
  const store = new Map();
  const limitEnv = {
    RATE_LIMIT: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value) {
        store.set(key, value);
      }
    }
  };

  await enforceDailyLimit("1.2.3.4", limitEnv, 1);
  await assert.rejects(
    () => enforceDailyLimit("1.2.3.4", limitEnv, 1),
    (err) => err.status === 429
  );
  await enforceDailyLimit("1.2.3.4", limitEnv, 0);
});

test("the deploy-time cap still applies when no override is passed", async () => {
  const store = new Map();
  const limitEnv = {
    DAILY_REQUEST_LIMIT: "60",
    RATE_LIMIT: {
      async get(key) {
        return store.get(key) ?? null;
      },
      async put(key, value) {
        store.set(key, value);
      }
    }
  };

  await enforceDailyLimit("5.6.7.8", limitEnv);
  const [key] = [...store.keys()];
  assert.equal(store.get(key), "1");
});

test("constant-time compare rejects length and value mismatches", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual(undefined, "abc"), false);
});
