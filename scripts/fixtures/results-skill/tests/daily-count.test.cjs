const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const prefix = "pomodoro-completed-work:";

function openApp({ storage = new Map(), time = "2026-09-26T10:00:00", blockRead = false, blockWrite = false } = {}) {
  let now = new Date(time).getTime();
  let intervalId = 0;
  const intervals = new Map();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => {
    const listeners = new Map();
    return [id, {
      textContent: "", dataset: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, callback) { listeners.set(name, callback); },
      click() { listeners.get("click")?.(); }
    }];
  }));
  const modes = [elements.get("work-mode"), elements.get("break-mode")];
  modes[0].dataset.mode = "work";
  modes[1].dataset.mode = "break";
  const document = {
    body: { dataset: {} }, visibilityState: "visible",
    getElementById: id => elements.get(id),
    querySelectorAll: () => modes,
    addEventListener: (name, callback) => documentEvents.set(name, callback)
  };
  const window = {
    localStorage: {
      getItem(key) {
        if (blockRead) throw new Error("Storage read blocked");
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (blockWrite) throw new Error("Storage write blocked");
        storage.set(key, value);
      }
    },
    setInterval(callback) { intervals.set(++intervalId, callback); return intervalId; },
    clearInterval: id => intervals.delete(id),
    addEventListener: (name, callback) => windowEvents.set(name, callback)
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  vm.runInNewContext(script, { document, window, Date: Clock });
  const flush = () => {
    for (const [id, callback] of [...intervals]) if (intervals.has(id)) callback();
  };
  return {
    storage,
    text: id => elements.get(id)?.textContent,
    count: () => Number(elements.get("daily-count")?.textContent),
    click: id => elements.get(id).click(),
    advance(milliseconds) { now += milliseconds; flush(); },
    setTime(value, flushTimers = true) { now = new Date(value).getTime(); if (flushTimers) flush(); },
    visible: () => documentEvents.get("visibilitychange")(),
    storageChanged: () => windowEvents.get("storage")(),
    complete(minutes) { elements.get("toggle").click(); now += minutes * 60000; flush(); }
  };
}

test("only completed work increments; pause, reset and mode changes do not", () => {
  const app = openApp();
  assert.equal(app.count(), 0);
  app.click("toggle");
  app.advance(1000);
  app.click("toggle");
  assert.equal(app.count(), 0);
  app.click("reset");
  app.click("break-mode");
  app.complete(5);
  assert.equal(app.count(), 0);
  app.complete(25);
  assert.equal(app.count(), 1);
  app.advance(2000);
  assert.equal(app.count(), 1);
  app.click("reset");
  app.click("work-mode");
  assert.equal(app.count(), 1);
  app.complete(25);
  assert.equal(app.count(), 2);
});

test("four work sessions still lead to a long break and preserve the daily total", () => {
  const app = openApp();
  for (let cycle = 1; cycle <= 4; cycle++) {
    app.complete(25);
    assert.equal(app.count(), cycle);
    assert.equal(app.text("timer"), cycle === 4 ? "15:00" : "05:00");
    app.complete(cycle === 4 ? 15 : 5);
    assert.equal(app.count(), cycle);
  }
  assert.equal(app.text("timer"), "25:00");
  assert.match(app.text("cycle"), /1\/4/);
});

test("reload restores today's total and the next local date starts at zero", () => {
  const app = openApp();
  app.complete(25);
  assert.equal(openApp({ storage: app.storage }).count(), 1);
  assert.equal(openApp({ storage: app.storage, time: "2026-09-27T00:00:00" }).count(), 0);
  app.setTime("2026-09-27T00:00:00");
  assert.equal(app.count(), 0);
  assert.equal(app.storage.get(prefix + "2026-09-26"), "1");
});

test("work spanning local midnight belongs to the completion date", () => {
  const app = openApp({ time: "2026-09-26T23:50:00" });
  app.complete(25);
  assert.equal(app.count(), 1);
  assert.equal(app.storage.get(prefix + "2026-09-27"), "1");
  assert.equal(app.storage.has(prefix + "2026-09-26"), false);
});

test("a delayed tick after midnight records the actual deadline's date", () => {
  const app = openApp({ time: "2026-09-26T23:30:00" });
  app.click("toggle");
  app.setTime("2026-09-27T00:10:00", false);
  app.visible();
  assert.equal(app.count(), 0);
  assert.equal(app.storage.get(prefix + "2026-09-26"), "1");
});

test("invalid saved counts are ignored without breaking work completion", () => {
  for (const value of ["broken", "-2", "1.5", "Infinity", "9007199254740992"]) {
    const app = openApp({ storage: new Map([[prefix + "2026-09-26", value]]) });
    assert.equal(app.count(), 0);
    app.complete(25);
    assert.equal(app.count(), 1);
  }
});

test("blocked storage retains counts in memory, including failed writes to existing data", () => {
  for (const options of [{ blockRead: true, blockWrite: true }, { blockWrite: true }]) {
    const app = openApp({ storage: new Map([[prefix + "2026-09-26", "3"]]), ...options });
    const initial = app.count();
    app.complete(25);
    app.advance(1000);
    assert.equal(app.count(), initial + 1);
    app.click("work-mode");
    app.complete(25);
    assert.equal(app.count(), initial + 2);
    app.setTime("2026-09-27T00:00:00");
    assert.equal(app.count(), 0);
  }
});

test("another tab's saved completion appears and is preserved on the next completion", () => {
  const app = openApp();
  app.storage.set(prefix + "2026-09-26", "3");
  app.storageChanged();
  assert.equal(app.count(), 3);
  app.complete(25);
  assert.equal(app.count(), 4);
});
