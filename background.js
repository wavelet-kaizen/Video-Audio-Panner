let globalCounter = 0;
let totalVideoCount = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getOffset" && typeof message.count === "number") {
    const offset = globalCounter;
    globalCounter += message.count;
    totalVideoCount += message.count;
    sendResponse({ offset: offset });
  } else if (message.type === "getTotalCount") {
    sendResponse({ totalCount: totalVideoCount });
  }
});

chrome.action.onClicked.addListener((tab) => {
  globalCounter = 0;
  totalVideoCount = 0;
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['content.js']
  });
});
