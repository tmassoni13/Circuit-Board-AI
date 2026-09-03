function loadBoardSettings() {
        const saved = JSON.parse(localStorage.getItem("pcb-board-settings") || "{}");
        document.getElementById("board-width-mm").value =
          saved.widthMm || DEFAULT_BOARD_WIDTH_MM;
        document.getElementById("board-height-mm").value =
          saved.heightMm || DEFAULT_BOARD_HEIGHT_MM;
        document.getElementById("camera-fov-width-mm").value =
          saved.fovWidthMm || DEFAULT_CAMERA_FOV_WIDTH_MM;
        document.getElementById("camera-fov-height-mm").value =
          saved.fovHeightMm || DEFAULT_CAMERA_FOV_HEIGHT_MM;
        document.getElementById("board-background-color").value =
          saved.backgroundColor ||
          legacyBackgroundColor(saved) ||
          DEFAULT_BOARD_BACKGROUND_COLOR;
        document.getElementById("gemini-upload-quality").value =
          GEMINI_UPLOAD_QUALITY_OPTIONS[saved.geminiUploadQuality]
            ? saved.geminiUploadQuality
            : DEFAULT_GEMINI_UPLOAD_QUALITY;
        loadSavedImageFolders();
        autoCaptureFolderName = saved.autoCaptureFolderName || DEFAULT_IMAGE_FOLDER_NAME;
        loadFolderPromptSettings();
        ensureImageFolder(autoCaptureFolderName);
        renderAutoCaptureFolderSelect();
        updateBoardFovSummary();
      }

      function readBoardSettings() {
        const backgroundColor = document.getElementById("board-background-color").value;
        const backgroundRgb = hexToRgb(backgroundColor);
        return {
          widthMm: clampNumberInput("board-width-mm", 10, 500, DEFAULT_BOARD_WIDTH_MM),
          heightMm: clampNumberInput("board-height-mm", 10, 500, DEFAULT_BOARD_HEIGHT_MM),
          fovWidthMm: clampNumberInput("camera-fov-width-mm", 10, 500, DEFAULT_CAMERA_FOV_WIDTH_MM),
          fovHeightMm: clampNumberInput("camera-fov-height-mm", 10, 500, DEFAULT_CAMERA_FOV_HEIGHT_MM),
          backgroundColor,
          backgroundR: backgroundRgb.r,
          backgroundG: backgroundRgb.g,
          backgroundB: backgroundRgb.b,
          autoCaptureFolderName,
          geminiUploadQuality: readGeminiUploadQuality()
        };
      }

      function readGeminiUploadQuality() {
        const select = document.getElementById("gemini-upload-quality");
        const quality = select ? select.value : DEFAULT_GEMINI_UPLOAD_QUALITY;
        return GEMINI_UPLOAD_QUALITY_OPTIONS[quality] ? quality : DEFAULT_GEMINI_UPLOAD_QUALITY;
      }

      function clampNumberInput(id, min, max, fallback) {
        const input = document.getElementById(id);
        const value = Number(input.value);

        if (document.activeElement === input) {
          if (input.value === "" || input.value === "-" || !Number.isFinite(value)) {
            return fallback;
          }

          return value;
        }

        const clamped = Number.isFinite(value) ? clamp(value, min, max) : fallback;
        input.value = clamped;
        return clamped;
      }

      function autoApplySettings() {
        const folderSelect = document.getElementById("auto-capture-folder");
        if (folderSelect) {
          autoCaptureFolderName = folderSelect.value || DEFAULT_IMAGE_FOLDER_NAME;
        }
        persistSettings(false);
        updateInspectionCounters();
      }

      function persistSettings(writeLog) {
        const settings = readBoardSettings();
        localStorage.setItem("pcb-board-settings", JSON.stringify(settings));
        searchPattern = buildFullAreaSearchPattern();
        resetSearchState();
        const bounds = getSearchBounds();
        updateBoardFovSummary(settings);
        if (writeLog) {
          appendTerminalLine(
            `[SETTINGS] board=${settings.widthMm}x${settings.heightMm}mm fov=${settings.fovWidthMm}x${settings.fovHeightMm}mm color=rgb(${settings.backgroundR},${settings.backgroundG},${settings.backgroundB}) travel=X${bounds.minX.toFixed(0)}..${bounds.maxX.toFixed(0)} Y${bounds.minY.toFixed(0)}..${bounds.maxY.toFixed(0)} targets=${searchPattern.length}`
          );
        }
      }

      function resetSettingsToDefaults() {
        document.getElementById("board-width-mm").value = DEFAULT_BOARD_WIDTH_MM;
        document.getElementById("board-height-mm").value = DEFAULT_BOARD_HEIGHT_MM;
        document.getElementById("camera-fov-width-mm").value = DEFAULT_CAMERA_FOV_WIDTH_MM;
        document.getElementById("camera-fov-height-mm").value = DEFAULT_CAMERA_FOV_HEIGHT_MM;
        document.getElementById("board-background-color").value = DEFAULT_BOARD_BACKGROUND_COLOR;
        document.getElementById("gemini-upload-quality").value = DEFAULT_GEMINI_UPLOAD_QUALITY;
        autoCaptureFolderName = DEFAULT_IMAGE_FOLDER_NAME;
        renderAutoCaptureFolderSelect();
        persistSettings(true);
      }

      function updateBoardFovSummary(settings = readBoardSettings()) {
        const capturePlan = buildBoardCapturePlan(settings);
        document.getElementById("board-fov-summary").innerHTML =
          `<span>BOARD: ${settings.widthMm} x ${settings.heightMm} mm</span>` +
          `<span>FOV: ${settings.fovWidthMm} x ${settings.fovHeightMm} mm</span>` +
          `<span>IPB: ${capturePlan.imagesPerBoard}</span>` +
          `<span>FOLDER: ${escapeHtml(settings.autoCaptureFolderName)}</span>`;
      }

      function calculateImagesPerBoard(settings) {
        return buildBoardCapturePlan(settings).imagesPerBoard;
      }

      function captureAlignmentModeForSettings(settings = readBoardSettings()) {
        const needsHorizontalTravel = settings.widthMm > settings.fovWidthMm;
        const needsVerticalTravel = settings.heightMm > settings.fovHeightMm;

        if (needsHorizontalTravel && needsVerticalTravel) {
          return "bottom";
        }

        if (needsVerticalTravel) {
          return "bottom";
        }

        return "none";
      }

      function buildBoardCapturePlan(settings = readBoardSettings(), origin = "center") {
        const columns = imageCountForDimension(settings.widthMm, settings.fovWidthMm);
        const rows = imageCountForDimension(settings.heightMm, settings.fovHeightMm);
        const imagesPerBoard = columns * rows;
        const useFullFovStep = imagesPerBoard > 2;
        const xPositions = axisPositionsForDimension(
          settings.widthMm,
          settings.fovWidthMm,
          columns,
          origin,
          useFullFovStep
        );
        const yPositions = axisPositionsForDimension(
          settings.heightMm,
          settings.fovHeightMm,
          rows,
          origin,
          useFullFovStep
        );
        const positions = [];

        // Serpentine order keeps the axis from jumping back to the left side
        // after every row. The scan starts from the upper-left work area and
        // ends wherever the last tile is, then the caller can return to zero.
        for (let row = 0; row < rows; row += 1) {
          const orderedXPositions = row % 2 === 0
            ? xPositions
            : [...xPositions].reverse();

          for (let column = 0; column < orderedXPositions.length; column += 1) {
            positions.push({
              imageNumber: positions.length + 1,
              xMm: orderedXPositions[column],
              yMm: yPositions[row],
              row: row + 1,
              column: row % 2 === 0
                ? column + 1
                : orderedXPositions.length - column
            });
          }
        }

        return {
          columns,
          rows,
          imagesPerBoard,
          useFullFovStep,
          requiresAxisTravel: positions.length > 1,
          positions
        };
      }

      function imageCountForDimension(boardMm, fovMm) {
        if (boardMm <= fovMm) {
          return 1;
        }

        // Use a fixed overlap so adjacent images do not miss defects near tile
        // edges. The operator asked for 15 mm because the second tile was just
        // barely missing the board edge during testing.
        const usableStepMm = Math.max(1, fovMm - CAPTURE_OVERLAP_MM);
        return Math.max(2, Math.ceil((boardMm - fovMm) / usableStepMm) + 1);
      }

      function axisPositionsForDimension(boardMm, fovMm, count, origin = "center", useFullFovStep = false) {
        if (count <= 1) {
          return [0];
        }

        const stepMm = Math.max(1, useFullFovStep ? fovMm : fovMm - CAPTURE_OVERLAP_MM);
        const totalTravelMm = stepMm * (count - 1);
        const startMm = origin === "corner" ? 0 : -totalTravelMm / 2;
        const positions = [];

        for (let index = 0; index < count; index += 1) {
          positions.push(Number((startMm + stepMm * index).toFixed(3)));
        }

        return positions;
      }

      function legacyBackgroundColor(saved) {
        if (
          Number.isFinite(saved.backgroundR) &&
          Number.isFinite(saved.backgroundG) &&
          Number.isFinite(saved.backgroundB)
        ) {
          return rgbToHex(saved.backgroundR, saved.backgroundG, saved.backgroundB);
        }

        return null;
      }

      function hexToRgb(hex) {
        const value = hex.replace("#", "");
        return {
          r: parseInt(value.slice(0, 2), 16),
          g: parseInt(value.slice(2, 4), 16),
          b: parseInt(value.slice(4, 6), 16)
        };
      }

      function rgbToHex(red, green, blue) {
        return `#${componentToHex(red)}${componentToHex(green)}${componentToHex(blue)}`;
      }

      function componentToHex(value) {
        return Math.round(value).toString(16).padStart(2, "0");
      }

      function sampleBoardColorFromClick(event) {
        event.preventDefault();
        if (event.button !== 2 || event.target.closest("#settings-overlay")) {
          return;
        }

        const video = document.getElementById("webcam-preview");
        if (!video.videoWidth || !video.videoHeight) {
          appendTerminalLine("[COLOR] Cannot sample. Camera frame is not ready.");
          return;
        }

        const videoPoint = mouseEventToVideoPixel(event, video);
        if (!videoPoint) {
          appendTerminalLine("[COLOR] Click was outside the active camera image.");
          return;
        }

        const sampleCanvas = document.createElement("canvas");
        sampleCanvas.width = 1;
        sampleCanvas.height = 1;
        const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
        sampleContext.drawImage(
          video,
          videoPoint.x,
          videoPoint.y,
          1,
          1,
          0,
          0,
          1,
          1
        );

        const pixel = sampleContext.getImageData(0, 0, 1, 1).data;
        const red = pixel[0];
        const green = pixel[1];
        const blue = pixel[2];
        document.getElementById("board-background-color").value = rgbToHex(red, green, blue);
        persistSettings(false);
        appendTerminalLine(`[COLOR] board color sampled rgb(${red},${green},${blue})`);
      }

      function mouseEventToVideoPixel(event, video) {
        const rect = video.getBoundingClientRect();
        const videoAspect = video.videoWidth / video.videoHeight;
        const viewAspect = rect.width / rect.height;
        let displayedWidth = rect.width;
        let displayedHeight = rect.height;
        let offsetX = 0;
        let offsetY = 0;

        if (viewAspect > videoAspect) {
          displayedWidth = rect.height * videoAspect;
          offsetX = (rect.width - displayedWidth) / 2;
        } else {
          displayedHeight = rect.width / videoAspect;
          offsetY = (rect.height - displayedHeight) / 2;
        }

        const localX = event.clientX - rect.left - offsetX;
        const localY = event.clientY - rect.top - offsetY;
        if (localX < 0 || localY < 0 || localX > displayedWidth || localY > displayedHeight) {
          return null;
        }

        return {
          x: Math.min(video.videoWidth - 1, Math.max(0, Math.round(localX / displayedWidth * video.videoWidth))),
          y: Math.min(video.videoHeight - 1, Math.max(0, Math.round(localY / displayedHeight * video.videoHeight)))
        };
      }

