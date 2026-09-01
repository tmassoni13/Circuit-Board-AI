function openSettings() {
        closeImageLog();
        closeManualAxis();
        document.getElementById("settings-overlay").classList.add("active");
        refreshConveyorIoStatus(false);
        startConveyorIoPolling();
      }

      function closeSettings() {
        document.getElementById("settings-overlay").classList.remove("active");
        stopConveyorIoPolling();
      }

      function startConveyorIoPolling() {
        stopConveyorIoPolling();
        conveyorIoPollTimer = window.setInterval(() => {
          refreshConveyorIoStatus(false);
        }, CONVEYOR_IO_POLL_INTERVAL_MS);
      }

      function stopConveyorIoPolling() {
        if (conveyorIoPollTimer) {
          window.clearInterval(conveyorIoPollTimer);
          conveyorIoPollTimer = null;
        }
      }

      function openImageLog() {
        closeSettings();
        closeManualAxis();
        imageLogView = "folders";
        activeFolderPromptEditorName = null;
        renderImageLogView();
        document.getElementById("image-log-overlay").classList.add("active");
      }

      function renderImageLogView() {
        renderImageFolders();
        renderImageLog();
        renderImageLogPath();
        renderFolderPromptHeaderButton();
        updateInspectionCounters();
      }

      function closeImageLog() {
        activeFolderPromptEditorName = null;
        document.getElementById("image-log-overlay").classList.remove("active");
      }

      function openManualAxis() {
        closeSettings();
        closeImageLog();
        document.getElementById("manual-axis-overlay").classList.add("active");
      }

      function closeManualAxis() {
        const overlay = document.getElementById("manual-axis-overlay");
        if (overlay) {
          overlay.classList.remove("active");
        }
      }

      function showImageFolderRoot() {
        imageLogView = "folders";
        activeFolderPromptEditorName = null;
        renderImageLogView();
      }

      function nextCaptureName() {
        const settings = readBoardSettings();
        const imagesPerBoard = calculateImagesPerBoard(settings);
        const boardNumber = nextBoardNumber;

        if (imagesPerBoard <= 1) {
          nextBoardNumber += 1;
          nextImageNumberForBoard = 1;
          return String(boardNumber);
        }

        const imageNumber = nextImageNumberForBoard;
        nextImageNumberForBoard += 1;
        if (nextImageNumberForBoard > imagesPerBoard) {
          nextBoardNumber += 1;
          nextImageNumberForBoard = 1;
        }

        return `${boardNumber}.${imageNumber}`;
      }

      function addImageToLog(blob, imageName, folderName = activeImageFolderName) {
        const url = URL.createObjectURL(blob);
        const entry = {
          name: imageName,
          blob,
          url,
          capturedAt: new Date().toLocaleTimeString(),
          inspectionStatus: null,
          failureDescription: ""
        };
        getImageFolder(folderName).entries.unshift(entry);
        renderImageLogView();
        return entry;
      }

      function getActiveImageFolder() {
        let folder = getImageFolder(activeImageFolderName);
        activeImageFolderName = folder.name;
        return folder;
      }

      function getImageFolder(folderName) {
        let folder = imageFolders.find((candidate) => candidate.name === folderName);
        if (!folder) {
          folder = ensureImageFolder(folderName);
        }

        return folder;
      }

      function ensureImageFolder(folderName) {
        let folder = imageFolders.find((candidate) => candidate.name === folderName);
        if (!folder) {
          folder = {
            name: folderName,
            entries: [],
            promptNote: getSavedFolderPrompt(folderName)
          };
          imageFolders.push(folder);
        } else if (typeof folder.promptNote !== "string") {
          folder.promptNote = getSavedFolderPrompt(folderName);
        }

        return folder;
      }

      function loadSavedImageFolders() {
        const savedFolders = getSavedImageFolderNames();
        for (const folderName of savedFolders) {
          if (!folderName || PROTECTED_IMAGE_FOLDERS.indexOf(folderName) >= 0) {
            continue;
          }
          ensureImageFolder(folderName);
        }
      }

      function getSavedImageFolderNames() {
        try {
          const savedFolders = JSON.parse(localStorage.getItem("pcb-image-folders") || "[]");
          return Array.isArray(savedFolders) ? savedFolders : [];
        } catch (error) {
          return [];
        }
      }

      function saveImageFolderNames() {
        const userFolders = imageFolders
          .map((folder) => folder.name)
          .filter((folderName) => canDeleteImageFolder(folderName));
        localStorage.setItem("pcb-image-folders", JSON.stringify(userFolders));
      }

      function renderAutoCaptureFolderSelect() {
        const select = document.getElementById("auto-capture-folder");
        if (!select) {
          return;
        }

        select.innerHTML = imageFolders.map((folder) => (
          `<option value="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</option>`
        )).join("");
        if (!imageFolders.some((folder) => folder.name === autoCaptureFolderName)) {
          autoCaptureFolderName = DEFAULT_IMAGE_FOLDER_NAME;
        }
        select.value = autoCaptureFolderName;
      }

      function renderImageFolders() {
        const grid = document.getElementById("image-folder-grid");
        if (!grid) {
          return;
        }

        if (imageLogView !== "folders") {
          grid.classList.add("hidden");
          return;
        }

        grid.classList.remove("hidden");
        grid.innerHTML = imageFolders.map((folder) => `
          <div class="folder-card">
            <button class="folder-tile" type="button" onclick="selectImageFolder('${escapeJs(folder.name)}')">
              <div class="folder-icon"></div>
              <div>${escapeHtml(folder.name)}</div>
              <div class="folder-count">${folder.entries.length} images</div>
            </button>
            ${canDeleteImageFolder(folder.name) ? `<button class="folder-delete" type="button" onclick="deleteImageFolder('${escapeJs(folder.name)}')" aria-label="Delete folder ${escapeHtml(folder.name)}">X</button>` : ""}
          </div>
        `).join("") + `
          <button class="folder-tile" type="button" onclick="addImageFolder()" aria-label="Add folder">
            <div class="folder-plus">+</div>
          </button>
        `;
      }

      function selectImageFolder(folderName) {
        activeImageFolderName = folderName;
        activeFolderPromptEditorName = null;
        imageLogView = "folder";
        renderImageLogView();
      }

      function addImageFolder() {
        const folderName = window.prompt("Folder name");
        if (!folderName) {
          return;
        }

        const cleanName = folderName.trim();
        if (!cleanName) {
          return;
        }

        if (!imageFolders.some((folder) => folder.name.toLowerCase() === cleanName.toLowerCase())) {
          imageFolders.push({
            name: cleanName,
            entries: [],
            promptNote: ""
          });
        }

        activeImageFolderName = cleanName;
        autoCaptureFolderName = cleanName;
        renderAutoCaptureFolderSelect();
        saveImageFolderNames();
        persistSettings(false);
        imageLogView = "folder";
        renderImageLogView();
        appendTerminalLine(`[IMAGE LOG] Active folder: ${cleanName}`);
      }

      function loadFolderPromptSettings() {
        const promptMap = getSavedFolderPrompts();
        for (const folder of imageFolders) {
          folder.promptNote = canUseFolderPrompt(folder.name)
            ? (promptMap[folder.name] || "")
            : "";
        }
      }

      function getSavedFolderPrompts() {
        try {
          return JSON.parse(localStorage.getItem("pcb-folder-prompts") || "{}");
        } catch (error) {
          return {};
        }
      }

      function getSavedFolderPrompt(folderName) {
        if (!canUseFolderPrompt(folderName)) {
          return "";
        }

        return getSavedFolderPrompts()[folderName] || "";
      }

      function saveFolderPrompt(folderName, value) {
        const folder = getImageFolder(folderName);
        if (!canUseFolderPrompt(folder.name)) {
          return;
        }

        folder.promptNote = value;
        const promptMap = getSavedFolderPrompts();
        if (value.trim()) {
          promptMap[folder.name] = value;
        } else {
          delete promptMap[folder.name];
        }
        localStorage.setItem("pcb-folder-prompts", JSON.stringify(promptMap));
        updateFolderPromptButton(folder.name);
      }

      function getFolderPromptButtonText(folder) {
        if (activeFolderPromptEditorName === folder.name) {
          return "Save";
        }

        return folder.promptNote.trim() ? "Edit Gemini Context" : "Add Gemini Context";
      }

      function toggleActiveFolderPromptEditor() {
        toggleFolderPromptEditor(activeImageFolderName);
      }

      function toggleFolderPromptEditor(folderName) {
        activeFolderPromptEditorName = activeFolderPromptEditorName === folderName ? null : folderName;
        renderImageLogPath();
        renderFolderPromptHeaderButton();
        const editor = document.getElementById("folder-prompt-note");
        if (editor) {
          editor.focus();
        }
      }

      function updateFolderPromptButton(folderName) {
        const button = document.getElementById("folder-prompt-toggle");
        if (!button || activeImageFolderName !== folderName) {
          return;
        }

        button.textContent = getFolderPromptButtonText(getImageFolder(folderName));
      }

      function renderFolderPromptHeaderButton() {
        const button = document.getElementById("folder-prompt-toggle");
        if (!button) {
          return;
        }

        const showButton = imageLogView === "folder" && canUseFolderPrompt(activeImageFolderName);
        button.classList.toggle("hidden", !showButton);
        if (!showButton) {
          return;
        }

        button.textContent = getFolderPromptButtonText(getActiveImageFolder());
      }

      function canUseFolderPrompt(folderName) {
        return !PROTECTED_IMAGE_FOLDERS.some((protectedName) => protectedName === folderName);
      }

      function canDeleteImageFolder(folderName) {
        return !PROTECTED_IMAGE_FOLDERS.some((protectedName) => protectedName === folderName);
      }

      function deleteImageFolder(folderName) {
        if (!canDeleteImageFolder(folderName)) {
          appendTerminalLine(`[IMAGE LOG] Folder ${folderName} is required and cannot be deleted.`);
          return;
        }

        const index = imageFolders.findIndex((folder) => folder.name === folderName);
        if (index < 0) {
          return;
        }

        if (!window.confirm(`Delete folder "${folderName}" and all images inside it?`)) {
          return;
        }

        const [folder] = imageFolders.splice(index, 1);
        for (const entry of folder.entries) {
          URL.revokeObjectURL(entry.url);
          removeFailureCopiesForImage(entry.name, false);
        }
        if (activeFolderPromptEditorName === folderName) {
          activeFolderPromptEditorName = null;
        }
        const promptMap = getSavedFolderPrompts();
        delete promptMap[folderName];
        localStorage.setItem("pcb-folder-prompts", JSON.stringify(promptMap));
        saveImageFolderNames();

        if (activeImageFolderName === folderName) {
          activeImageFolderName = DEFAULT_IMAGE_FOLDER_NAME;
          imageLogView = "folders";
        }

        if (autoCaptureFolderName === folderName) {
          autoCaptureFolderName = DEFAULT_IMAGE_FOLDER_NAME;
          renderAutoCaptureFolderSelect();
          persistSettings(false);
        }

        closeImagePreview();
        renderImageLogView();
        appendTerminalLine(`[IMAGE LOG] Deleted folder ${folderName}.`);
      }

      function renderImageLog() {
        const grid = document.getElementById("image-log-grid");
        if (!grid) {
          return;
        }

        if (imageLogView !== "folder") {
          grid.classList.add("hidden");
          return;
        }

        grid.classList.remove("hidden");
        const folder = getActiveImageFolder();
        if (folder.entries.length === 0) {
          grid.innerHTML = `<div class="empty-log">No Images In ${escapeHtml(folder.name)}</div>`;
          return;
        }

        grid.innerHTML = folder.entries.map((entry) => `
          <article class="image-log-card ${entry.inspectionStatus === "pass" ? "pass" : entry.inspectionStatus === "fail" ? "fail" : ""}">
            <button class="image-open-button" type="button" onclick="openImagePreview('${escapeJs(entry.name)}')">
              <img src="${entry.url}" alt="Board image ${entry.name}">
            </button>
            <div class="image-log-name">Image ${entry.name}</div>
            <div class="image-log-meta">${escapeHtml(folder.name)} | ${entry.capturedAt}</div>
            ${entry.failureDescription ? `<div class="image-log-reason">${escapeHtml(entry.failureDescription)}</div>` : ""}
            <div class="image-log-actions">
              <button class="image-analyze" type="button" onclick="analyzeImageFromLog('${escapeJs(entry.name)}')">Gemini</button>
              <button class="image-delete" type="button" onclick="deleteImageFromLog('${escapeJs(entry.name)}')">Delete</button>
            </div>
          </article>
        `).join("");
      }

      function renderFolderContextControl(folder) {
        if (!canUseFolderPrompt(folder.name)) {
          return "";
        }

        const editorOpen = activeFolderPromptEditorName === folder.name;
        if (!editorOpen) {
          return "";
        }

        return `
          <div class="folder-context-control">
            <textarea id="folder-prompt-note" class="folder-context-editor" oninput="saveFolderPrompt('${escapeJs(folder.name)}', this.value)" placeholder="Example: J3 and R12 are intentionally unpopulated on this board revision. Hand soldered jumper from TP1 to TP2 is expected.">${escapeHtml(folder.promptNote || "")}</textarea>
          </div>
        `;
      }

      async function analyzeImageFromLog(imageName) {
        const folder = getActiveImageFolder();
        const entry = folder.entries.find((candidate) => candidate.name === imageName);
        if (!entry || !entry.blob) {
          appendTerminalLine(`[GEMINI ERROR] image ${imageName}: image data is not available.`);
          return;
        }

        appendTerminalLine(`[GEMINI] manual test for image ${imageName} from ${folder.name}.`);
        await analyzeBoardImages(
          imageName,
          [{ name: imageName, blob: entry.blob }],
          "IMAGE LOG",
          folder.promptNote || ""
        );
      }

      function openImagePreview(imageName) {
        const folder = getActiveImageFolder();
        const entry = folder.entries.find((candidate) => candidate.name === imageName);
        if (!entry) {
          return;
        }

        document.getElementById("image-preview-title").textContent = `Image ${entry.name}`;
        document.getElementById("image-preview-img").src = entry.url;
        document.getElementById("image-preview").classList.add("active");
      }

      function closeImagePreview() {
        document.getElementById("image-preview").classList.remove("active");
      }

      function deleteImageFromLog(imageName) {
        const folder = getActiveImageFolder();
        const index = folder.entries.findIndex((candidate) => candidate.name === imageName);
        if (index < 0) {
          return;
        }

        const [entry] = folder.entries.splice(index, 1);
        URL.revokeObjectURL(entry.url);
        if (folder.name !== FAILURE_IMAGE_FOLDER_NAME) {
          removeFailureCopiesForImage(imageName);
        }
        closeImagePreview();
        renderImageLogView();
        appendTerminalLine(`[IMAGE LOG] Deleted image ${imageName} from ${folder.name}.`);
      }

      function renderImageLogPath() {
        const path = document.getElementById("image-log-path");
        const label = document.getElementById("image-log-path-label");
        if (!path || !label) {
          return;
        }

        const existingControl = path.querySelector(".folder-context-control");
        if (existingControl) {
          existingControl.remove();
        }

        if (imageLogView !== "folder") {
          path.classList.remove("active");
          return;
        }

        label.textContent = `Image Log / ${activeImageFolderName}`;
        const folder = getActiveImageFolder();
        path.insertAdjacentHTML("beforeend", renderFolderContextControl(folder));
        path.classList.add("active");
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }

      function escapeJs(value) {
        return String(value)
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'");
      }

