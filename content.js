(() => {
  // Repeated declarative and programmatic injections share one audio graph.
  if (globalThis.__videoAudioPanner) return;

  const records = new WeakMap();
  const active = new Map();
  const resized = new Set();
  let nextId = 0;
  let automatic = false;
  let context = null;
  let resumePending = false;
  let changeTimer = null;

  function notifyChanges() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: "videosChanged" }).catch(() => {});
    }, 100);
  }

  function containsMedia(node) {
    return node.nodeType === 1 && (node.matches("video, iframe, frame") || node.querySelector("video, iframe, frame"));
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => [...mutation.addedNodes, ...mutation.removedNodes].some(containsMedia))) notifyChanges();
  });
  const layoutObserver = new MutationObserver(notifyChanges);
  const resizeObserver = new ResizeObserver(notifyChanges);

  function onFrameLoad(event) {
    if (event.target.matches?.("iframe, frame")) notifyChanges();
  }

  function onTransition(event) {
    if (containsMedia(event.target)) notifyChanges();
  }

  function setAutomatic(enabled) {
    if (automatic === enabled) return;
    automatic = enabled;
    if (enabled) {
      observer.observe(document, { childList: true, subtree: true });
      document.addEventListener("load", onFrameLoad, true);
      document.addEventListener("transitionend", onTransition, true);
      window.addEventListener("resize", notifyChanges);
    } else {
      observer.disconnect();
      layoutObserver.disconnect();
      resizeObserver.disconnect();
      resized.clear();
      clearTimeout(changeTimer);
      document.removeEventListener("load", onFrameLoad, true);
      document.removeEventListener("transitionend", onTransition, true);
      window.removeEventListener("resize", notifyChanges);
      for (const record of active.values()) {
        record.pan = 0;
        if (record.panner) record.panner.pan.value = 0;
      }
    }
  }

  function trackLayout(elements) {
    if (!automatic) return;
    const watched = new Set([document.documentElement, ...elements]);
    for (const element of resized) {
      if (!watched.has(element)) {
        resizeObserver.unobserve(element);
        resized.delete(element);
      }
    }
    layoutObserver.disconnect();
    const ancestors = new Set();
    for (const element of watched) {
      if (!resized.has(element)) {
        resizeObserver.observe(element);
        resized.add(element);
      }
      for (let parent = element; parent; parent = parent.parentElement) ancestors.add(parent);
    }
    // Exclude constantly changing player controls; watch media ancestors only.
    for (const element of ancestors) {
      layoutObserver.observe(element, { attributes: true, attributeFilter: ["class", "style", "hidden"] });
    }
  }

  function getRect(element) {
    const rect = element.getBoundingClientRect();
    const visibility = getComputedStyle(element).visibility;
    return {
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      visible: rect.width > 0 && rect.height > 0 && visibility !== "hidden" && visibility !== "collapse"
    };
  }

  function getFramePath() {
    const path = [];
    let current = window;
    while (current !== current.top) {
      const parent = current.parent;
      let index = 0;
      // These Window properties are available across origins.
      while (index < parent.length && parent.frames[index] !== current) index++;
      if (index === parent.length) return null;
      path.unshift(index);
      current = parent;
    }
    return path;
  }

  function snapshot(enabled) {
    setAutomatic(enabled);
    const path = getFramePath();
    if (!path) return null;
    const videos = Array.from(document.querySelectorAll("video"));
    const live = new Set(videos);
    for (const [id, record] of active) {
      if (!live.has(record.video)) {
        record.source?.disconnect();
        record.panner?.disconnect();
        record.connected = false;
        active.delete(id);
      }
    }
    const children = Array.from(document.querySelectorAll("iframe, frame"));
    trackLayout([...videos, ...children]);
    return {
      path,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      videos: videos.map((video) => {
        let record = records.get(video);
        if (!record) {
          record = { id: nextId++, video, pan: null, connected: false, failed: false };
          records.set(video, record);
        }
        active.set(record.id, record);
        return { id: record.id, ...getRect(video) };
      }),
      children: children.map((child) => {
        const rect = getRect(child);
        const scaleX = child.offsetWidth ? rect.width / child.offsetWidth : 1;
        const scaleY = child.offsetHeight ? rect.height / child.offsetHeight : 1;
        return {
          index: Array.from(window.frames).indexOf(child.contentWindow),
          ...rect,
          left: rect.left + child.clientLeft * scaleX,
          top: rect.top + child.clientTop * scaleY,
          width: child.clientWidth * scaleX,
          height: child.clientHeight * scaleY
        };
      })
    };
  }

  function resumeAudio(force = false) {
    if (!context || context.state === "running" || (resumePending && !force)) return;
    resumePending = true;
    context.resume().then(() => {
      resumePending = false;
      updateAudio();
    }).catch((error) => {
      resumePending = false;
      console.warn("音声処理を再開できませんでした:", error.message);
    });
  }

  function updateAudio() {
    if (![...active.values()].some((record) => record.pan !== null && !record.failed)) return;
    if (!context) {
      context = new (window.AudioContext || window.webkitAudioContext)();
      context.addEventListener("statechange", () => {
        if (context.state === "running") updateAudio();
      });
    }
    // Do not reroute media into a suspended context: preserve its original sound
    // until autoplay is allowed or the user interacts with the video.
    if (context.state !== "running") {
      resumeAudio();
      return;
    }
    for (const record of active.values()) {
      if (record.pan === null || record.failed) continue;
      try {
        if (!record.source) {
          record.panner = context.createStereoPanner();
          record.source = context.createMediaElementSource(record.video);
        }
        record.panner.pan.value = record.pan;
        if (!record.connected) {
          record.source.connect(record.panner);
          record.panner.connect(context.destination);
          record.connected = true;
        }
      } catch (error) {
        record.failed = true;
        console.error("VIDEO要素の処理中にエラー:", record.video, error);
      }
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "setAutomatic") setAutomatic(message.enabled);
    if (message.type === "applyPanning") {
      const assignments = new Map(message.assignments.map(({ id, pan }) => [id, pan]));
      for (const record of active.values()) {
        record.pan = assignments.get(record.id) ?? (record.source ? 0 : null);
        if (record.panner) record.panner.pan.value = record.pan ?? 0;
      }
      updateAudio();
    }
  });

  for (const event of ["pointerdown", "keydown", "play"]) {
    document.addEventListener(event, () => resumeAudio(true), true);
  }
  globalThis.__videoAudioPanner = { snapshot };

  function requestAutomatic() {
    if (window === window.top && location.origin === "https://holodex.net" && /^\/multiview(?:\/|$)/.test(location.pathname)) notifyChanges();
  }
  window.addEventListener("pageshow", requestAutomatic);
  requestAutomatic();
})();
