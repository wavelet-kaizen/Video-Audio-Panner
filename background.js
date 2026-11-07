const updates = new Map();
const updateDelay = 150;

function isHolodex(url) {
  try {
    return new URL(url).origin === "https://holodex.net";
  } catch {
    return false;
  }
}

function isMultiview(url) {
  return isHolodex(url) && /^\/multiview(?:\/|$)/.test(new URL(url).pathname);
}

function getPanValues(count) {
  switch (count) {
    case 1: return [0];
    case 2: return [-0.8, 0.8];
    case 3: return [-0.8, 0, 0.8];
    case 4: return [-0.8, -0.65, 0.8, 0.65];
    default: return [-1, 1, 0];
  }
}

function comparePaths(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// Reconstruct screen coordinates from parent iframe rectangles. Cross-origin
// frame documents are read only by the content script injected into that frame.
function getVideos(frames, automatic) {
  const byPath = new Map(frames.map((frame) => [frame.result.path.join("/"), frame]));
  const geometry = new Map();
  function getGeometry(frame) {
    const { path, viewport } = frame.result;
    const key = path.join("/");
    if (geometry.has(key)) return geometry.get(key);
    let value = null;
    if (path.length === 0) {
      value = { left: 0, top: 0, scaleX: 1, scaleY: 1, visible: true };
    } else {
      const parent = byPath.get(path.slice(0, -1).join("/"));
      const host = parent?.result.children.find((child) => child.index === path.at(-1));
      const outer = parent && getGeometry(parent);
      if (host && outer && viewport.width > 0 && viewport.height > 0) {
        value = {
          left: outer.left + host.left * outer.scaleX,
          top: outer.top + host.top * outer.scaleY,
          scaleX: outer.scaleX * host.width / viewport.width,
          scaleY: outer.scaleY * host.height / viewport.height,
          visible: outer.visible && host.visible
        };
      }
    }
    geometry.set(key, value);
    return value;
  }

  const videos = [];
  frames.sort((a, b) => comparePaths(a.result.path, b.result.path));
  for (const frame of frames) {
    const outer = getGeometry(frame);
    for (const video of frame.result.videos) {
      if (automatic && (!video.visible || (outer && !outer.visible))) continue;
      const rect = outer && video.visible ? {
        left: outer.left + video.left * outer.scaleX,
        top: outer.top + video.top * outer.scaleY,
        width: video.width * outer.scaleX,
        height: video.height * outer.scaleY
      } : null;
      videos.push({ frame, id: video.id, rect });
    }
  }
  return videos;
}

function assignPanning(videos, usePosition) {
  const pattern = getPanValues(videos.length);
  videos.forEach((video, index) => { video.pan = pattern[index % pattern.length]; });
  if (!usePosition || videos.length < 2 || videos.length > 4 || videos.some((video) => !video.rect)) return;

  const centerX = (video) => video.rect.left + video.rect.width / 2;
  if (videos.length === 2) {
    const ordered = [...videos].sort((a, b) => centerX(a) - centerX(b) || a.rect.top - b.rect.top);
    ordered[0].pan = -0.8;
    ordered[1].pan = 0.8;
    return;
  }

  const left = Math.min(...videos.map((video) => video.rect.left));
  const right = Math.max(...videos.map((video) => video.rect.left + video.rect.width));
  const middle = (left + right) / 2;
  const centerBand = (right - left) * 0.1;
  // Center-spanning videos stay centered. Upper videos in each side column use
  // 80%; lower videos use 65%, regardless of insertion order or iframe IDs.
  for (const side of [-1, 0, 1]) {
    const column = videos.filter((video) => {
      const offset = centerX(video) - middle;
      return (Math.abs(offset) <= centerBand ? 0 : Math.sign(offset)) === side;
    }).sort((a, b) => a.rect.top - b.rect.top || centerX(a) - centerX(b));
    column.forEach((video, index) => { video.pan = side * (index === 0 ? 0.8 : 0.65); });
  }
}

async function updateTab(tabId, manual) {
  const tab = await chrome.tabs.get(tabId);
  const automatic = isMultiview(tab.url);
  if (!automatic && !manual) {
    await chrome.tabs.sendMessage(tabId, { type: "setAutomatic", enabled: false }).catch(() => {});
    return;
  }

  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (enabled) => globalThis.__videoAudioPanner?.snapshot(enabled),
    args: [automatic]
  });
  const frames = results.filter((frame) => frame.result);
  const videos = getVideos(frames, automatic);
  assignPanning(videos, automatic);
  await Promise.all(frames.map((frame) => chrome.tabs.sendMessage(tabId, {
    type: "applyPanning",
    assignments: videos.filter((video) => video.frame === frame).map(({ id, pan }) => ({ id, pan }))
  }, { documentId: frame.documentId }).catch(() => {
    // A frame may disappear or navigate between collection and application.
  })));
}

function scheduleUpdate(tabId, manual = false) {
  let state = updates.get(tabId);
  if (!state) {
    state = { running: false, manual: false, dirty: false, timer: null };
    updates.set(tabId, state);
  }
  state.manual ||= manual;
  if (state.running) {
    state.dirty = true;
    return;
  }
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    state.running = true;
    const requestedManually = state.manual;
    state.manual = false;
    state.dirty = false;
    try {
      await updateTab(tabId, requestedManually);
    } catch (error) {
      console.warn("音声振り分けを更新できませんでした:", error.message);
    } finally {
      state.running = false;
      if (updates.get(tabId) === state) {
        if (state.dirty || state.manual) scheduleUpdate(tabId);
        else updates.delete(tabId);
      }
    }
  }, updateDelay);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "videosChanged" && sender.tab?.id !== undefined) scheduleUpdate(sender.tab.id);
});

chrome.action.onClicked.addListener((tab) => scheduleUpdate(tab.id, true));

// This also covers Holodex's client-side URL changes, without URL polling.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if ((isHolodex(tab.url) && (change.url || change.status === "complete")) || (change.url && updates.has(tabId))) scheduleUpdate(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(updates.get(tabId)?.timer);
  updates.delete(tabId);
});
