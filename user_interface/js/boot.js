loadBoardSettings();
      document.addEventListener("keydown", handleGlobalKeyboardShortcuts);
      window.addEventListener("beforeunload", protectActiveCycleFromReload);
      openPreviewCamera();
      autoConnectAxis();

