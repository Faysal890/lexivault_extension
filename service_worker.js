chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.get(['lxDefaultLang'], ({ lxDefaultLang }) => {
      if (!lxDefaultLang) {
        chrome.storage.local.set({ lxDefaultLang: 'bn' });
      }
    });
  }
});
