// Optional real-browser check: node tests/edge-smoke.cjs (Node 22+, Windows Edge).
// All test HTTPS requests are fulfilled locally through DevTools interception.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const browserPath = process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wav = Buffer.alloc(44 + 16000 * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let sample = 0; sample < 16000; sample++) wav.writeInt16LE(Math.round(2048 * Math.sin(sample * Math.PI * 440 / 4000)), 44 + sample * 2);
const mediaUrl = `data:audio/wav;base64,${wav.toString("base64")}`;
async function until(fn, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

async function main() {
  const profile = path.join(root, "env", `edge-smoke-${Date.now()}`);
  await fs.mkdir(profile, { recursive: true });
  let browserLog = "";
  const browser = spawn(browserPath, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, `--disable-extensions-except=${root}`,
    `--load-extension=${root}`, "about:blank"
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  browser.on("error", (error) => { browserLog += error.message; });
  browser.stderr.on("data", (chunk) => { browserLog = (browserLog + chunk).slice(-4000); });
  let send;
  let socket;
  try {
    const portInfo = await until(async () => {
      try { return await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8"); } catch { return null; }
    }, "Edge DevTools startup");
    const [port, endpoint] = portInfo.trim().split(/\r?\n/);
    const versionResponse = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!versionResponse.ok) throw new Error(`DevTools HTTP ${versionResponse.status}: ${await versionResponse.text()}`);
    await versionResponse.json();
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = (event) => reject(event.error || new Error(event.message || "DevTools WebSocket failed")); });
    let serial = 0;
    const pending = new Map();
    const sessions = new Map();
    const contexts = new Map();
    const errors = [];
    send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (request) message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
        return;
      }
      const { method, params, sessionId } = message;
      if (method === "Target.attachedToTarget") {
        const sid = params.sessionId;
        const info = { ...params.targetInfo, ready: false };
        sessions.set(sid, info);
        (async () => {
          await send("Runtime.enable", {}, sid);
          if (["page", "iframe"].includes(info.type)) {
            await send("Fetch.enable", { patterns: [{ urlPattern: "https://holodex.net/*" }, { urlPattern: "https://*.test/*" }] }, sid);
            await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid);
          }
          info.ready = true;
          await send("Runtime.runIfWaitingForDebugger", {}, sid);
        })().catch((error) => errors.push(error.message));
      }
      if (method === "Runtime.executionContextCreated") contexts.set(`${sessionId}:${params.context.id}`, { sessionId, ...params.context });
      if (method === "Runtime.executionContextDestroyed") contexts.delete(`${sessionId}:${params.executionContextId}`);
      if (method === "Runtime.executionContextsCleared") {
        for (const [key, context] of contexts) if (context.sessionId === sessionId) contexts.delete(key);
      }
      if (method === "Target.detachedFromTarget") {
        sessions.delete(params.sessionId);
        for (const [key, context] of contexts) if (context.sessionId === params.sessionId) contexts.delete(key);
      }
      if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
      if (method === "Runtime.consoleAPICalled" && params.type === "error") errors.push(params.args.map((arg) => arg.value || arg.description).join(" "));
      if (method === "Page.javascriptDialogOpening") {
        errors.push(`Unexpected dialog: ${params.message}`);
        send("Page.handleJavaScriptDialog", { accept: true }, sessionId).catch(() => {});
      }
      if (method === "Fetch.requestPaused") {
        const url = new URL(params.request.url);
        const html = url.hostname === "holodex.net" ? `<!doctype html><style>
          body { margin: 0; } iframe { position: absolute; width: 400px; height: 300px; border: 0; }
          button { position: fixed; top: 0; left: 0; z-index: 10; width: 100px; height: 40px; }
          @media (min-width: 1000px) { #b { left: 0 !important; } #c { left: 400px !important; } }
          </style>${[["a", 400, 300], ["b", 0, 0], ["c", 400, 0], ["d", 0, 300]].map(([id, x, y]) =>
          `<iframe id="${id}" src="https://video.test/${id}" style="left:${x}px;top:${y}px" allow="autoplay"></iframe>`).join("")}<button id="play">Play all</button><script>
          document.getElementById('play').addEventListener('click', () => {
            for (const frame of document.querySelectorAll('iframe')) frame.contentWindow.postMessage('play', '*');
          });</script>` :
          `<!doctype html><style>html,body{margin:0;width:100%;height:100%}video{width:100%;height:100%}</style><video loop src="${mediaUrl}"></video><script>
          window.addEventListener('message', (event) => { if (event.data === 'play') document.querySelector('video').play().catch((error) => console.warn(error.message)); });</script>`;
        send("Fetch.fulfillRequest", {
          requestId: params.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
          body: Buffer.from(html).toString("base64")
        }, sessionId).catch((error) => errors.push(error.message));
      }
    };

    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetId } = await send("Target.createTarget", { url: "about:blank", newWindow: true, width: 800, height: 600 });
    const pageSession = await until(() => [...sessions].find(([, info]) => info.targetId === targetId && info.ready)?.[0], "page attachment");
    await send("Page.enable", {}, pageSession);
    await send("Page.navigate", { url: "https://holodex.net/multiview" }, pageSession);

    async function evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true }, pageSession);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    }
    async function playAll() {
      await until(() => evaluate("!!document.getElementById('play')"), "play button");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 40, y: 20, button: "left", clickCount: 1 }, pageSession);
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 40, y: 20, button: "left", clickCount: 1 }, pageSession);
    }
    async function audioValues() {
      const output = {};
      for (const context of [...contexts.values()]) {
        try {
          const probe = await send("Runtime.evaluate", {
            expression: "({active:!!globalThis.__videoAudioPanner,path:location.pathname,playing:!!document.querySelector('video') && !document.querySelector('video').paused && document.querySelector('video').readyState >= 2})", contextId: context.id, returnByValue: true
          }, context.sessionId);
          if (!probe.result.value?.active || !/^\/[a-d]$/.test(probe.result.value.path)) continue;
          const proto = await send("Runtime.evaluate", { expression: "StereoPannerNode.prototype", contextId: context.id }, context.sessionId);
          const objects = await send("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId }, context.sessionId);
          const values = await send("Runtime.callFunctionOn", {
            objectId: objects.objects.objectId, functionDeclaration: "function(){return this.filter(node=>node.context.state==='running').map(node=>node.pan.value)}", returnByValue: true
          }, context.sessionId);
          output[probe.result.value.path] = probe.result.value.playing ? values.result.value : [];
          await send("Runtime.releaseObject", { objectId: objects.objects.objectId }, context.sessionId);
        } catch (error) {
          if (!/context|session|target|object|uniqueId/i.test(error.message)) throw error;
        }
      }
      return output;
    }
    const expected = async (values, label) => {
      const actual = await until(async () => {
        const current = await audioValues();
        return Object.entries(values).every(([key, value]) => current[key]?.length === 1 && Math.abs(current[key][0] - value) < 0.0001) && current;
      }, label);
      console.log(`${label}: ${JSON.stringify(actual)}`);
    };

    await until(async () => Object.keys(await audioValues()).length === 4, "initial frame collection");
    await playAll();
    await expected({ "/a": 0.65, "/b": -0.8, "/c": 0.8, "/d": -0.65 }, "4 cross-origin frames after playback");
    await evaluate("document.querySelector('#b').style.left='400px'; document.querySelector('#c').style.left='0px'");
    await expected({ "/a": 0.65, "/b": 0.8, "/c": -0.8, "/d": -0.65 }, "same-count position swap");
    await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false }, pageSession);
    await expected({ "/a": 0.65, "/b": -0.8, "/c": 0.8, "/d": -0.65 }, "viewport resize changes CSS layout");
    await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, pageSession);
    await expected({ "/a": 0.65, "/b": 0.8, "/c": -0.8, "/d": -0.65 }, "viewport resize restores layout");
    await evaluate("document.querySelector('#a').remove()");
    await expected({ "/b": 0.8, "/c": -0.8, "/d": -0.65 }, "frame removal to 3");
    await evaluate("for (const [id, top, left] of [['d',0,0.5],['b',200,0],['c',400,1]]) { document.getElementById(id).style.cssText = `left:${left}px;top:${top}px;width:400px;height:200px`; }");
    await expected({ "/d": -0.8, "/b": 0.8, "/c": 0 }, "vertical column uses top-to-bottom left, right, center");
    await evaluate("for (const [id, left, top] of [['b',400,0],['c',0,0],['d',0,300]]) { document.getElementById(id).style.cssText = `left:${left}px;top:${top}px;width:400px;height:300px`; }");
    await expected({ "/b": 0.8, "/c": -0.8, "/d": -0.65 }, "return from vertical column restores position panning");
    await evaluate("document.body.insertAdjacentHTML('beforeend','<iframe id=\"a\" src=\"https://video.test/a\" style=\"left:400px;top:300px\" allow=\"autoplay\"></iframe>')");
    await until(async () => Object.keys(await audioValues()).length === 4, "new frame collection");
    await playAll();
    await expected({ "/a": 0.65, "/b": 0.8, "/c": -0.8, "/d": -0.65 }, "late frame addition");
    await evaluate("history.pushState({}, '', '/watch/test')");
    await expected({ "/a": 0, "/b": 0, "/c": 0, "/d": 0 }, "SPA exit resets panning");
    await evaluate("history.pushState({}, '', '/multiview')");
    await expected({ "/a": 0.65, "/b": 0.8, "/c": -0.8, "/d": -0.65 }, "SPA return resumes panning");
    assert.deepEqual(errors, []);
    const version = await send("Browser.getVersion");
    console.log(`PASS: ${version.product}; no browser exceptions`);
  } catch (error) {
    console.error(browserLog);
    throw error;
  } finally {
    if (send) await send("Browser.close").catch(() => {});
    socket?.close();
    if (!send) browser.kill();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
