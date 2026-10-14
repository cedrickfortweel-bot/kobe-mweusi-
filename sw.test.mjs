/* Tests for the push handler in sw.js.

   sw.js is a service worker, so there is no DOM. The approach here is to
   load the file with a stubbed `self` and then invoke the handlers that were
   registered, exactly as the browser would.

   Run with: node supabase/../sw.test.mjs   (from the repo root) */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const swSource = readFileSync(path.join(here, "sw.js"), "utf8");

/* ------------------------------------------------------------------ *
 * Minimal ServiceWorkerGlobalScope stub                             *
 * ------------------------------------------------------------------ */

const ORIGIN = "https://kobe.example.tz";

function makeRegistration() {
  const shown = [];
  return {
    showNotification: async (title, options) => {
      shown.push({ title, options });
      return undefined;
    },
    shown,
    pushManager: null,
  };
}

/**
 * Loads sw.js into a fresh stub scope and returns helpers for invoking the
 * registered listeners and inspecting what happened.
 */
async function loadSw({ clients = [] } = {}) {
  const listeners = new Map();
  const registration = makeRegistration();
  const postedToClients = [];
  const opened = [];

  const clientList = clients.map((c) => ({
    ...c,
    postMessage: (msg) => postedToClients.push({ client: c.id ?? "client", msg }),
  }));

  const self = {
    location: new URL(ORIGIN),
    registration,
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    clients: {
      matchAll: async () => clientList,
      openWindow: async (url) => {
        opened.push(url);
        return { focus: async () => undefined };
      },
      claim: async () => {},
      control: () => {},
    },
    skipWaiting: () => {},
    PushManager: function PushManager() {},
  };

  // Evaluate the service worker file in this scope.
  const factory = new Function(
    "self",
    "location",
    "caches",
    "fetch",
    `${swSource}`
  );
  const fakeCaches = {
    open: async () => ({
      add: async () => {},
      put: async () => {},
      match: async () => undefined,
    }),
    keys: async () => [],
    delete: async () => {},
    match: async () => undefined,
  };
  const fakeFetch = async () => new Response("", { status: 200 });
  factory.call(self, self, self.location, fakeCaches, fakeFetch);

  const fire = (type, event) => {
    const handlers = listeners.get(type) ?? [];
    for (const handler of handlers) handler(event);
  };

  const fireAsync = async (type, event) => {
    const handlers = listeners.get(type) ?? [];
    await Promise.all(handlers.map((h) => h(event)));
  };

  return { self, fire, fireAsync, registration, postedToClients, opened, listeners };
}

/* ------------------------------------------------------------------ */
/* Test runner                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}`);
    console.log(`      ${error.message.split("\n")[0]}`);
  }
}

/** Build a fake FetchEvent-like push event with a readable JSON payload. */
function pushEvent(payload, { jsonThrows = false, hasData = true } = {}) {
  return {
    type: "push",
    data: hasData
      ? {
          json: () => (jsonThrows ? JSON.parse("{ not json") : JSON.parse(typeof payload === "string" ? payload : JSON.stringify(payload))),
          text: async () => "",
        }
      : null,
    waitUntil: async (p) => {
      await p;
    },
  };
}

console.log("\nService worker registration");

await test("registers install, activate, message, notificationclick, push and fetch listeners", async () => {
  const loaded = await loadSw();
  const types = [...loaded.listeners.keys()];
  for (const t of ["install", "activate", "message", "notificationclick", "push", "fetch"]) {
    assert.ok(types.includes(t), `listener ${t} registered`);
  }
});

await test("PUSH_RESUBSCRIBE message handling is preserved", async () => {
  const clients = [{ id: "c1", focus: async () => undefined }];
  const loaded = await loadSw({ clients });
  // Give the one-shot getSubscription promise a chance to resolve.
  loaded.self.registration.pushManager = { getSubscription: async () => ({ endpoint: "https://x.test" }) };
  await loaded.fireAsync("message", {
    type: "message",
    data: { type: "PUSH_RESUBSCRIBE" },
    waitUntil: async (p) => p,
  });
  await new Promise((r) => setTimeout(r, 0));
  const msgs = loaded.postedToClients.map((m) => m.msg.type);
  assert.ok(msgs.includes("PUSH_RESUBSCRIBE"), "client receives PUSH_RESUBSCRIBE");
  assert.ok(
    loaded.postedToClients.some((m) => m.msg.subscription && m.msg.subscription.endpoint === "https://x.test"),
    "subscription passed through"
  );
});

await test("CACHE_URL message handling is preserved", async () => {
  const clients = [{ id: "c1", focus: async () => undefined }];
  const loaded = await loadSw({ clients });
  await loaded.fireAsync("message", {
    type: "message",
    data: { type: "CACHE_URL", url: `${ORIGIN}/buyer.html` },
    waitUntil: async (p) => p,
  });
});

console.log("\nPush payload handling");

await test("shows a notification for a well-formed payload", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({ title: "New order KM-ABC", body: "Tap to view", data: { link: "/seller.html#seller-orders" } }));
  assert.equal(loaded.registration.shown.length, 1, "one notification shown");
  const shown = loaded.registration.shown[0];
  assert.equal(shown.title, "New order KM-ABC");
  assert.equal(shown.options.body, "Tap to view");
  assert.equal(shown.options.data.link, "/seller.html#seller-orders");
});

await test("falls back to a default title and empty body", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({}));
  assert.equal(loaded.registration.shown.length, 1);
  assert.equal(loaded.registration.shown[0].title, "Kobe Mweusi");
  assert.equal(loaded.registration.shown[0].options.body, "");

  const loaded2 = await loadSw();
  await loaded2.fireAsync("push", pushEvent({ title: "   ", body: null }));
  assert.equal(loaded2.registration.shown[0].title, "Kobe Mweusi", "blank title falls back");
  assert.equal(loaded2.registration.shown[0].options.body, "", "null body becomes empty");
});

await test("survives an unparseable payload", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent("", { jsonThrows: true }));
  assert.equal(loaded.registration.shown.length, 1, "still shows a fallback notification");
  assert.equal(loaded.registration.shown[0].title, "Kobe Mweusi");
});

await test("survives a missing payload without throwing", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent(null, { hasData: false }));
  assert.equal(loaded.registration.shown.length, 1, "fallback notification shown");
  assert.equal(loaded.registration.shown[0].title, "Kobe Mweusi");
  assert.equal(loaded.registration.shown[0].options.data.link, "/buyer.html");
});

await test("non-string body values are coerced safely", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({ title: "T", body: { evil: true } }));
  assert.equal(loaded.registration.shown[0].options.body, "", "object body becomes empty string");
});

console.log("\nLink safety");

await test("keeps a valid same-origin deep link", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: { link: "/buyer.html#disputes" } }));
  assert.equal(loaded.registration.shown[0].options.data.link, "/buyer.html#disputes");
});

await test("rejects an external protocol link", async () => {
  const loaded = await loadSw();
  for (const bad of [
    "https://evil.example.com/phish",
    "//evil.example.com/phish",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://evil.example.com",
  ]) {
    await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: { link: bad } }));
  }
  const links = loaded.registration.shown.map((s) => s.options.data.link);
  assert.deepEqual(links, Array(links.length).fill("/buyer.html"), "all unsafe links fall back");
});

await test("rejects a relative link that escapes to an unknown page", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: { link: "../../etc/passwd" } }));
  assert.notEqual(loaded.registration.shown[0].options.data.link, "../../etc/passwd");
  assert.match(loaded.registration.shown[0].options.data.link, /^\/buyer\.html/);
});

await test("unknown same-origin paths fall back", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: { link: "/random.html?x=1" } }));
  const link = loaded.registration.shown[0].options.data.link;
  assert.match(link, /^\/buyer\.html/, "path replaced with the fallback app");
  assert.ok(link.includes("x=1"), "harmless query context is preserved");
});

await test("missing or empty link falls back", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: { link: "" } }));
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: {} }));
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B" }));
  assert.equal(loaded.registration.shown.length, 3);
  for (const s of loaded.registration.shown) assert.equal(s.options.data.link, "/buyer.html");
});

await test("non-string link values are handled", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: { link: 42 } }));
  assert.match(loaded.registration.shown[0].options.data.link, /^\/buyer\.html/);
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: { link: null } }));
  assert.match(loaded.registration.shown[1].options.data.link, /^\/buyer\.html/);
});

await test("evil.example.com in a different origin is never shown", async () => {
  const loaded = await loadSw();
  await loaded.fireAsync("push", pushEvent({ title: "T", body: "B", data: { link: "https://kobe.example.tz.evil.com/x" } }));
  assert.match(loaded.registration.shown[0].options.data.link, /^\/buyer\.html/);
});

console.log("\nNotification click");

await test("click opens a focused client and posts OPEN_LINK", async () => {
  const clients = [{ id: "c1", focus: async () => undefined }];
  const loaded = await loadSw({ clients });
  const notification = {
    close: () => {},
    data: { link: "/seller.html#seller-orders" },
  };
  await loaded.fireAsync("notificationclick", { notification, waitUntil: async (p) => p });
  const posted = loaded.postedToClients.find((m) => m.msg.type === "OPEN_LINK");
  assert.ok(posted, "OPEN_LINK posted");
  assert.equal(posted.msg.link, `${ORIGIN}/seller.html#seller-orders`);
  assert.equal(loaded.opened.length, 0, "no new window when a client exists");
});

await test("click opens a window when no client exists", async () => {
  const loaded = await loadSw({ clients: [] });
  await loaded.fireAsync("notificationclick", {
    notification: { close: () => {}, data: { link: "https://evil.example.com/phish" } },
    waitUntil: async (p) => p,
  });
  assert.equal(loaded.opened.length, 1);
  assert.equal(loaded.opened[0], `${ORIGIN}/buyer.html`);
});

await test("a stale cache name is not used by the push handler", async () => {
  const loaded = await loadSw();
  assert.match(swSource, /CACHE = 'kobe-mweusi-v4'/);
  assert.ok(!/kobe-mweusi-v3/.test(swSource), "old cache name removed");
  void loaded;
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.log(`--- ${f.name} ---\n${f.error.stack ?? f.error}`);
  process.exit(1);
}
