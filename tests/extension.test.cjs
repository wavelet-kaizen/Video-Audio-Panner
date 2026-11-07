const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");

const backgroundCode = readFileSync(resolve(__dirname, "../background.js"), "utf8");
const contentCode = readFileSync(resolve(__dirname, "../content.js"), "utf8");
const rect = (left = 0, top = 0, width = 400, height = 300) => ({ left, top, width, height });

function event() {
  const listeners = [];
  return { listeners, addListener: (listener) => listeners.push(listener), emit: (...args) => listeners.forEach((listener) => listener(...args)) };
}

function harness(initialUrl = "https://holodex.net/multiview", blocked = false) {
  const timers = new Map();
  const tabs = new Map();
  const warnings = [];
  let nextTimer = 0;
  let nextDocument = 0;
  let injectionFailures = 0;
  let missingSnapshots = 0;
  let injectionAttempts = 0;
  const setTimeout = (fn) => { timers.set(++nextTimer, fn); return nextTimer; };
  const clearTimeout = (id) => timers.delete(id);
  const chrome = {
    runtime: { onMessage: event(), onStartup: event() },
    action: { onClicked: event() },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      get: async (id) => ({ id, url: tabs.get(id).url }),
      query: async () => [...tabs.values()].filter((tab) => tab.url.startsWith("https://holodex.net/")).map(({ id, url }) => ({ id, url })),
      sendMessage: async (id, message, options) => {
        const frames = tabs.get(id).frames.filter((frame) => !options || frame.documentId === options.documentId);
        frames.forEach((frame) => frame.messages.emit(message));
      }
    },
    scripting: {
      executeScript: async ({ target, files, func, args }) => {
        if (files) {
          injectionAttempts++;
          if (injectionFailures > 0) {
            injectionFailures--;
            throw new Error("Frame is still loading");
          }
        }
        // Reverse the results to model the browser's unspecified frame order.
        return [...tabs.get(target.tabId).frames].reverse().map((frame) => {
          frame.sandbox.__args = args;
          if (!files && frame.path.length && missingSnapshots > 0) {
            missingSnapshots--;
            return { frameId: frame.frameId, documentId: frame.documentId };
          }
          const result = vm.runInContext(files ? contentCode : `(${func.toString()})(...__args)`, frame.sandbox);
          return { frameId: frame.frameId, documentId: frame.documentId, result: result && JSON.parse(JSON.stringify(result)) };
        });
      }
    }
  };
  const logger = { error: (...args) => warnings.push(args), warn: (...args) => warnings.push(args) };
  function restartWorker() {
    for (const e of [chrome.runtime.onMessage, chrome.runtime.onStartup, chrome.action.onClicked, chrome.tabs.onUpdated, chrome.tabs.onRemoved]) e.listeners.length = 0;
    vm.runInNewContext(backgroundCode, { chrome, URL, setTimeout, clearTimeout, console: logger });
  }
  restartWorker();

  function element(type, box = rect()) {
    return {
      type, rect: box, nodeType: 1, parentElement: null,
      matches(selector) { return selector.split(", ").includes(type); },
      querySelector() { return null; },
      getBoundingClientRect() { return this.rect; }
    };
  }

  function addTab(id, url) {
    const tab = { id, url, frames: [] };
    tabs.set(id, tab);
    return tab;
  }
  const firstTab = addTab(1, initialUrl);

  function addFrame(path = [], videoRects = [], hostRect = rect(), tab = firstTab) {
    const documentEvents = new Map();
    const windowEvents = new Map();
    const observers = [];
    const messages = event();
    const contexts = [];
    const dom = { videos: videoRects.map((box) => element("video", box)), children: [] };
    const documentElement = element("html");
    const document = {
      documentElement,
      visibilityState: "visible",
      querySelectorAll: (selector) => selector === "video" ? dom.videos : dom.children,
      addEventListener: (name, listener) => {
        if (!documentEvents.has(name)) documentEvents.set(name, new Set());
        documentEvents.get(name).add(listener);
      },
      removeEventListener: (name, listener) => documentEvents.get(name)?.delete(listener)
    };
    class MutationObserver {
      constructor(callback) { this.callback = callback; this.nodes = new Map(); this.kind = "mutation"; observers.push(this); }
      observe(node, options) { this.nodes.set(node, options); }
      disconnect() { this.nodes.clear(); }
    }
    class ResizeObserver extends MutationObserver {
      constructor(callback) { super(callback); this.kind = "resize"; }
      unobserve(node) { this.nodes.delete(node); }
    }
    class AudioContext {
      constructor() {
        this.state = blocked ? "suspended" : "running";
        this.destination = {};
        this.pending = [];
        this.handlers = [];
        contexts.push(this);
      }
      addEventListener(name, listener) { this.handlers.push(listener); }
      resume() {
        if (this.state === "running") return Promise.resolve();
        return new Promise((resolve) => this.pending.push(resolve));
      }
      allow() {
        this.state = "running";
        this.handlers.forEach((listener) => listener());
        this.pending.splice(0).forEach((resolve) => resolve());
      }
      createStereoPanner() { return { pan: { value: 0 }, connect() {}, disconnect() {} }; }
      createMediaElementSource(video) {
        assert.equal(video.source, undefined, "a media element must never be bound twice");
        video.sourceCount = (video.sourceCount || 0) + 1;
        video.source = {
          connect(panner) { this.panner = panner; this.connected = true; },
          disconnect() { this.connected = false; }
        };
        return video.source;
      }
    }
    const window = {
      frames: [], innerWidth: path.length ? hostRect.width : 800, innerHeight: path.length ? hostRect.height : 600,
      AudioContext,
      addEventListener: (name, listener) => {
        if (!windowEvents.has(name)) windowEvents.set(name, new Set());
        windowEvents.get(name).add(listener);
      },
      removeEventListener: (name, listener) => windowEvents.get(name)?.delete(listener)
    };
    Object.defineProperty(window, "length", { get: () => window.frames.length });
    const sandbox = vm.createContext({
      window, document, location: new URL(tab.url), MutationObserver, ResizeObserver,
      getComputedStyle: (node) => ({ visibility: node.hidden ? "hidden" : "visible" }),
      setTimeout, clearTimeout, console: logger,
      chrome: { runtime: {
        onMessage: messages,
        sendMessage: async (message) => chrome.runtime.onMessage.emit(message, { tab: { id: tab.id } })
      } }
    });
    const frame = {
      path, window, sandbox, dom, contexts, observers, messages, document,
      documentId: `document-${++nextDocument}`, frameId: nextDocument,
      host: element("iframe", hostRect),
      mutate() {
        observers.filter((o) => o.kind === "mutation" && o.nodes.get(document)?.childList)
          .forEach((o) => o.callback([{ addedNodes: [element("video")], removedNodes: [] }]));
      },
      layout() {
        observers.filter((o) => o.kind === "mutation" && [...o.nodes.values()].some((v) => v?.attributes))
          .forEach((o) => o.callback([]));
      },
      resize() { windowEvents.get("resize")?.forEach((listener) => listener()); },
      load(child) { documentEvents.get("load")?.forEach((listener) => listener({ target: child.host })); },
      play(name = "play") { documentEvents.get(name)?.forEach((listener) => listener({ target: dom.videos[0] })); },
      pan(index = 0) { return dom.videos[index].source?.panner.pan.value; },
      isWatching() { return observers.some((o) => o.nodes.size > 0); }
    };
    for (const video of dom.videos) video.parentElement = documentElement;
    frame.host.contentWindow = window;
    Object.defineProperties(frame.host, {
      offsetWidth: { get: () => frame.host.rect.width }, offsetHeight: { get: () => frame.host.rect.height },
      clientWidth: { get: () => frame.host.rect.width }, clientHeight: { get: () => frame.host.rect.height },
      clientLeft: { value: 0 }, clientTop: { value: 0 }
    });
    tab.frames.push(frame);
    const top = tab.frames.find((other) => other.path.length === 0);
    window.top = top.window;
    window.parent = path.length ? tab.frames.find((other) => JSON.stringify(other.path) === JSON.stringify(path.slice(0, -1))).window : window;
    if (path.length) {
      window.parent.frames[path.at(-1)] = window;
      const parent = tab.frames.find((other) => other.window === window.parent);
      frame.host.parentElement = parent.document.documentElement;
      parent.dom.children.push(frame.host);
    }
    return frame;
  }

  async function flush() {
    for (let iteration = 0; iteration < 20; iteration++) {
      await new Promise(setImmediate);
      if (!timers.size) return;
      const pending = [...timers];
      timers.clear();
      for (const [, callback] of pending) await callback();
    }
    assert.fail("update loop did not settle");
  }

  return {
    firstTab, addTab, addFrame, element, warnings, flush, restartWorker,
    failInjections(count) { injectionFailures = count; },
    missSnapshots(count) { missingSnapshots = count; },
    get injectionAttempts() { return injectionAttempts; },
    startup() { chrome.runtime.onStartup.emit(); },
    start(tab = firstTab) { vm.runInContext(contentCode, tab.frames[0].sandbox); },
    click(tab = firstTab) { chrome.action.onClicked.emit({ id: tab.id }); },
    navigate(url, tab = firstTab) {
      tab.url = url;
      tab.frames[0].sandbox.location = new URL(url);
      chrome.tabs.onUpdated.emit(tab.id, { url }, { id: tab.id, url });
    }
  };
}

test("automatic layout follows physical positions across unordered iframe results", async () => {
  const h = harness();
  h.addFrame();
  const bottomRight = h.addFrame([0], [rect()], rect(400, 300));
  const topLeft = h.addFrame([1], [rect()], rect(0, 0));
  const topRight = h.addFrame([2], [rect()], rect(400, 0));
  const bottomLeft = h.addFrame([3], [rect()], rect(0, 300));
  h.start();
  await h.flush();
  assert.deepEqual([topLeft.pan(), bottomLeft.pan(), topRight.pan(), bottomRight.pan()], [-0.8, -0.65, 0.8, 0.65]);
  assert.deepEqual(h.warnings, []);
});

test("positions update without video count changes and without rebuilding audio", async () => {
  const h = harness();
  const root = h.addFrame([], [rect(400), rect(0)]);
  h.start();
  await h.flush();
  assert.deepEqual([root.pan(0), root.pan(1)], [0.8, -0.8]);
  [root.dom.videos[0].rect, root.dom.videos[1].rect] = [root.dom.videos[1].rect, root.dom.videos[0].rect];
  root.layout();
  root.resize();
  await h.flush();
  assert.deepEqual([root.pan(0), root.pan(1)], [-0.8, 0.8]);
  assert.equal(root.contexts.length, 1);
  assert.deepEqual(root.dom.videos.map((video) => video.sourceCount), [1, 1]);
});

test("late iframes and videos are detected, and existing sources survive additions", async () => {
  const h = harness();
  const root = h.addFrame();
  const left = h.addFrame([0], [rect()], rect(0));
  h.start();
  await h.flush();
  assert.equal(left.pan(), 0);
  const right = h.addFrame([1], [], rect(400));
  root.load(right);
  await h.flush();
  right.dom.videos.push(h.element("video"));
  right.mutate();
  await h.flush();
  assert.equal(left.pan(), -0.8);
  assert.equal(right.pan(), 0.8);
  assert.equal(left.dom.videos[0].sourceCount, 1);
  assert.deepEqual(h.warnings, []);
});

test("removal down to zero and reinsertion reuse the same media source", async () => {
  const h = harness();
  const root = h.addFrame([], [rect(0), rect(400)]);
  h.start();
  await h.flush();
  const removed = root.dom.videos.pop();
  root.mutate();
  await h.flush();
  assert.equal(root.pan(), 0);
  assert.equal(removed.source.connected, false);
  const first = root.dom.videos.pop();
  root.mutate();
  await h.flush();
  assert.equal(first.source.connected, false);
  root.dom.videos.push(removed, first);
  root.mutate();
  await h.flush();
  assert.deepEqual([root.pan(0), root.pan(1)], [0.8, -0.8]);
  assert.equal(removed.sourceCount, 1);
  assert.equal(first.sourceCount, 1);
  assert.deepEqual(h.warnings, []);
});

test("three videos use actual columns and center-spanning videos stay centered", async () => {
  const h = harness();
  const root = h.addFrame([], [rect(0, 0, 800), rect(400, 300), rect(0, 300)]);
  h.start();
  await h.flush();
  assert.deepEqual(root.dom.videos.map((_, i) => root.pan(i)), [0, 0.8, -0.8]);
  root.dom.videos[0].rect = rect(0);
  root.layout();
  await h.flush();
  assert.deepEqual(root.dom.videos.map((_, i) => root.pan(i)), [-0.8, 0.8, -0.65]);
});

test("three videos in one vertical column use screen order across iframes", async () => {
  const h = harness();
  h.addFrame();
  const bottom = h.addFrame([0], [rect(0, 0, 400, 200)], rect(200, 400, 400, 200));
  const top = h.addFrame([1], [rect(0, 0, 400, 200)], rect(200.5, 0, 400, 200));
  const middle = h.addFrame([2], [rect(0, 0, 400, 200)], rect(201, 200, 400, 200));
  h.start();
  await h.flush();
  assert.deepEqual([top.pan(), middle.pan(), bottom.pan()], [-0.8, 0.8, 0]);
  assert.deepEqual(h.warnings, []);
});

test("vertical layouts with two or three videos update when positions change", async () => {
  for (const count of [2, 3]) {
    const h = harness();
    const horizontal = Array.from({ length: count }, (_, i) => rect(i * 200, 0, 200, 200));
    const root = h.addFrame([], horizontal);
    h.start();
    await h.flush();
    const horizontalPans = count === 2 ? [-0.8, 0.8] : [-0.8, 0, 0.8];
    assert.deepEqual(root.dom.videos.map((_, i) => root.pan(i)), horizontalPans);
    root.dom.videos.forEach((video, i) => { video.rect = rect(i * 0.5, (count - 1 - i) * 200, 200, 200); });
    root.layout();
    await h.flush();
    assert.deepEqual(root.dom.videos.map((_, i) => root.pan(i)), count === 2 ? [0.8, -0.8] : [0, 0.8, -0.8]);
    root.dom.videos.forEach((video, i) => { video.rect = horizontal[i]; });
    root.layout();
    await h.flush();
    assert.deepEqual(root.dom.videos.map((_, i) => root.pan(i)), horizontalPans);
    assert.deepEqual(root.dom.videos.map((video) => video.sourceCount), Array(count).fill(1));
    assert.deepEqual(h.warnings, []);
  }
});

test("nested and scaled iframe coordinates are composed with parent positions", async () => {
  const h = harness();
  h.addFrame();
  const left = h.addFrame([0], [rect(0, 0, 400, 300)], rect(0, 0));
  const wrapper = h.addFrame([1], [], rect(400, 0));
  wrapper.window.innerWidth = 800;
  wrapper.window.innerHeight = 600;
  const right = h.addFrame([1, 0], [rect()], rect(0, 0, 800, 600));
  h.start();
  await h.flush();
  assert.deepEqual([left.pan(), right.pan()], [-0.8, 0.8]);
});

test("hidden frames are excluded from the automatic layout", async () => {
  const h = harness();
  h.addFrame();
  const visible = h.addFrame([0], [rect()], rect(0));
  const hidden = h.addFrame([1], [rect()], rect(400));
  hidden.host.hidden = true;
  h.start();
  await h.flush();
  assert.equal(visible.pan(), 0);
  assert.equal(hidden.contexts.length, 0);
});

test("manual mode preserves requested count patterns, without starting observers", async () => {
  for (const [count, expected] of [[0, []], [1, [0]], [2, [-0.8, 0.8]], [3, [-0.8, 0, 0.8]], [4, [-0.8, -0.65, 0.8, 0.65]], [6, [-1, 1, 0, -1, 1, 0]]]) {
    const h = harness("https://example.com/watch");
    const root = h.addFrame([], Array.from({ length: count }, () => rect()));
    h.start();
    await h.flush();
    assert.equal(root.contexts.length, 0);
    h.click();
    await h.flush();
    h.click();
    await h.flush();
    assert.deepEqual(root.dom.videos.map((_, i) => root.pan(i)), expected);
    assert.equal(root.isWatching(), false);
    assert.equal(root.messages.listeners.length, 1);
    assert.deepEqual(h.warnings, []);
  }
});

test("SPA entry, exit and return enable and disable monitoring", async () => {
  const h = harness("https://holodex.net/");
  const root = h.addFrame([], [rect(0), rect(400)]);
  h.start();
  await h.flush();
  assert.equal(root.isWatching(), false);
  h.navigate("https://holodex.net/multiview?layout=test");
  await h.flush();
  assert.equal(root.isWatching(), true);
  assert.equal(root.pan(), -0.8);
  h.navigate("https://holodex.net/watch/test");
  await h.flush();
  assert.equal(root.isWatching(), false);
  assert.deepEqual([root.pan(0), root.pan(1)], [0, 0]);
  h.navigate("https://holodex.net/multiview/");
  await h.flush();
  assert.equal(root.pan(), -0.8);
  assert.equal(root.dom.videos[0].sourceCount, 1);
});

test("blocked autoplay never reroutes audio before the context can run", async () => {
  const h = harness(undefined, true);
  const root = h.addFrame([], [rect(0), rect(400)]);
  h.start();
  await h.flush();
  assert.equal(root.dom.videos[0].source, undefined);
  root.contexts[0].allow();
  root.play();
  await h.flush();
  assert.deepEqual([root.pan(0), root.pan(1)], [-0.8, 0.8]);
  assert.equal(root.dom.videos[0].sourceCount, 1);
});

test("automatic updates wake a fresh service worker and tabs stay independent", async () => {
  const h = harness();
  const first = h.addFrame([], [rect(0), rect(400)]);
  const secondTab = h.addTab(2, "https://holodex.net/multiview");
  const second = h.addFrame([], [rect()], rect(), secondTab);
  h.start();
  h.start(secondTab);
  await h.flush();
  assert.deepEqual([first.pan(), second.pan()], [-0.8, 0]);
  h.restartWorker();
  first.dom.videos.pop();
  first.mutate();
  await h.flush();
  assert.deepEqual([first.pan(), second.pan()], [0, 0]);
  assert.deepEqual(h.warnings, []);
});

test("initial Holodex injection watches iframe loads before the first snapshot", () => {
  const h = harness();
  const root = h.addFrame();
  h.start();
  assert.equal(root.isWatching(), true);
});

test("playback recollects existing videos that were not visible during initialization", async () => {
  for (const playbackEvent of ["play", "playing", "loadedmetadata"]) {
    const h = harness();
    const root = h.addFrame([], [rect(0, 0, 0, 0), rect(0, 0, 0, 0)]);
    h.start();
    await h.flush();
    assert.equal(root.contexts.length, 0);
    root.dom.videos.forEach((video, i) => { video.rect = rect(i * 400); });
    // No insertion, resize callback, or attribute event occurs before playback.
    root.play(playbackEvent);
    await h.flush();
    assert.deepEqual([root.pan(0), root.pan(1)], [-0.8, 0.8]);
    assert.deepEqual(h.warnings, []);
  }
});

test("automatic initialization retries transient iframe injection failures", async () => {
  const h = harness();
  const root = h.addFrame([], [rect(0), rect(400)]);
  h.failInjections(2);
  h.start();
  await h.flush();
  assert.deepEqual([root.pan(0), root.pan(1)], [-0.8, 0.8]);
});

test("automatic initialization retries when a frame navigates between injection and collection", async () => {
  const h = harness();
  h.addFrame();
  const left = h.addFrame([0], [rect()], rect(0));
  const right = h.addFrame([1], [rect()], rect(400));
  h.missSnapshots(1);
  h.start();
  await h.flush();
  assert.deepEqual([left.pan(), right.pan()], [-0.8, 0.8]);
});

test("persistent initialization errors stop retrying instead of polling forever", async () => {
  const h = harness();
  const root = h.addFrame([], [rect()]);
  h.failInjections(100);
  h.start();
  await h.flush();
  assert.equal(root.pan(), undefined);
  assert.ok(h.injectionAttempts <= 4);
});

test("an unavailable non-video frame does not prevent other videos from panning", async () => {
  const h = harness();
  const root = h.addFrame([], [rect(0), rect(400)]);
  h.addFrame([0]);
  h.missSnapshots(100);
  h.start();
  await h.flush();
  assert.deepEqual([root.pan(0), root.pan(1)], [-0.8, 0.8]);
  assert.ok(h.injectionAttempts <= 4);
});

test("browser startup initializes restored multiview tabs without page changes", async () => {
  const h = harness();
  const root = h.addFrame([], [rect(0), rect(400)]);
  const otherTab = h.addTab(2, "https://example.com/watch");
  const other = h.addFrame([], [rect()], rect(), otherTab);
  h.startup();
  await h.flush();
  assert.deepEqual([root.pan(0), root.pan(1)], [-0.8, 0.8]);
  assert.equal(other.contexts.length, 0);
  assert.equal(other.isWatching(), false);
});
