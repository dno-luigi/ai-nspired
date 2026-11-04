import test from "node:test";
import assert from "node:assert/strict";
import {
  getSwitches,
  setSwitches,
  clearSwitchCache,
  DEFAULTS
} from "../src/lib/switches.js";

function kvEnv() {
  const kv = new Map();
  return {
    SETTINGS: {
      async get(key) {
        return kv.has(key) ? JSON.parse(kv.get(key)) : null;
      },
      async put(key, value) {
        kv.set(key, value);
      }
    }
  };
}

test("without the binding the defaults apply", async () => {
  clearSwitchCache();
  const switches = await getSwitches({});
  assert.deepEqual(switches, { ...DEFAULTS });
});

test("a write persists and refreshes the writing isolate immediately", async () => {
  clearSwitchCache();
  const env = kvEnv();

  const { switches } = await setSwitches({ search: false, dailyCap: 5 }, env, {
    updatedBy: "architect"
  });
  assert.equal(switches.search, false);
  assert.equal(switches.dailyCap, 5);

  // Same isolate, inside the 10s cache window: the writer must not be stale.
  const cached = await getSwitches(env);
  assert.equal(cached.search, false);

  clearSwitchCache();
  const reread = await getSwitches(env, { fresh: true });
  assert.equal(reread.dailyCap, 5);
});

test("the cap is clamped and bad input is rejected", async () => {
  clearSwitchCache();
  const env = kvEnv();

  const { switches } = await setSwitches({ dailyCap: 999999 }, env);
  assert.equal(switches.dailyCap, 10000);

  await assert.rejects(
    () => setSwitches({ search: "yes" }, env),
    (err) => err.status === 400
  );
  await assert.rejects(
    () => setSwitches({ nope: true }, env),
    (err) => err.status === 400
  );
});

test("writing without the binding fails loudly", async () => {
  clearSwitchCache();
  await assert.rejects(
    () => setSwitches({ search: true }, {}),
    (err) => err.status === 503
  );
});
