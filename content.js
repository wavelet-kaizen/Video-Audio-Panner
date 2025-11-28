(function(){
  const videos = document.getElementsByTagName("video");
  if (videos.length === 0) return;

  chrome.runtime.sendMessage({ type: "getOffset", count: videos.length }, function(response) {
    if (!response || typeof response.offset !== "number") {
      console.error("有効なオフセットが取得できませんでした");
      return;
    }
    const offset = response.offset;
    
    chrome.runtime.sendMessage({ type: "getTotalCount" }, function(totalResponse) {
      if (!totalResponse || typeof totalResponse.totalCount !== "number") {
        console.error("総VIDEO要素数が取得できませんでした");
        return;
      }
      
      const totalCount = totalResponse.totalCount;
      let panValues;
      
      switch (totalCount) {
        case 1:
          panValues = [0];
          break;
        case 2:
          panValues = [-0.8, 0.8];
          break;
        case 3:
          panValues = [-0.8, 0.8, 0];
          break;
        case 4:
          panValues = [-1, 1, -0.65, 0.65];
          break;
        default:
          panValues = [-1, 1, 0];
          break;
      }
      
      for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        try {
          if (video.dataset.audioContext) {
            video.dataset.audioContext.close();
          }

          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          const source = audioContext.createMediaElementSource(video);
          const panner = audioContext.createStereoPanner();
          const panValue = panValues[(offset + i) % panValues.length];
          panner.pan.value = panValue;
          source.connect(panner).connect(audioContext.destination);
          
          video.dataset.audioContext = audioContext;
          video.dataset.panned = "true";
        } catch (e) {
          console.error("VIDEO要素の処理中にエラー:", video, e);
        }
      }
      
      if (offset === 0) {
        alert(`${totalCount}個のVIDEOの音声を振り分けました。`);
      }
    });
  });
})();
