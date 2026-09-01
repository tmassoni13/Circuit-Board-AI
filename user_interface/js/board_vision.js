function smoothedBoardOverlay(board) {
        // The color mask can move by a few pixels as lighting changes across
        // the PCB. Smoothing only the display box keeps the board status quick
        // while making the top and bottom edges less jumpy.
        if (!lastBoardBox) {
          return board;
        }

        const smoothing = 0.45;
        return {
          ...board,
          x: lastBoardBox.x * smoothing + board.x * (1 - smoothing),
          y: lastBoardBox.y * smoothing + board.y * (1 - smoothing),
          width: lastBoardBox.width * smoothing + board.width * (1 - smoothing),
          height: lastBoardBox.height * smoothing + board.height * (1 - smoothing)
        };
      }

      function findBoardBySelectedColor(video) {
        // This commissioning detector looks for the configured PCB substrate
        // color anywhere in the camera frame. The result is only a board
        // presence signal, not a defect inspection or component detector.
        const settings = readBoardSettings();
        const targetRgb = {
          red: settings.backgroundR,
          green: settings.backgroundG,
          blue: settings.backgroundB
        };
        const targetHsl = rgbToHsl(
          settings.backgroundR,
          settings.backgroundG,
          settings.backgroundB
        );
        const neutralDarkTarget = targetIsNeutralDarkBoard(targetHsl);
        const sampleWidth = 320;
        const sampleHeight = Math.max(1, Math.round(sampleWidth * video.videoHeight / video.videoWidth));
        const canvas = document.createElement("canvas");
        canvas.width = sampleWidth;
        canvas.height = sampleHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(video, 0, 0, sampleWidth, sampleHeight);
        const image = context.getImageData(0, 0, sampleWidth, sampleHeight);
        const data = image.data;
        const boxWidth = Math.round(sampleWidth * BOARD_BOX_WIDTH_RATIO);
        const boxHeight = Math.round(sampleHeight * BOARD_BOX_HEIGHT_RATIO);
        const boxX = Math.round((sampleWidth - boxWidth) / 2);
        const boxY = Math.round((sampleHeight - boxHeight) / 2);
        const boxRight = boxX + boxWidth;
        const boxBottom = boxY + boxHeight;
        const boardMask = new Uint8Array(sampleWidth * sampleHeight);

        for (let y = 0; y < sampleHeight; y += 1) {
          for (let x = 0; x < sampleWidth; x += 1) {
            const offset = (y * sampleWidth + x) * 4;
            const red = data[offset];
            const green = data[offset + 1];
            const blue = data[offset + 2];

            if (boardPixelMatches(red, green, blue, targetRgb, targetHsl)) {
              boardMask[y * sampleWidth + x] = 1;
            }
          }
        }

        const boardRegion = largestBoardRegion(
          boardMask,
          sampleWidth,
          sampleHeight,
          neutralDarkTarget
        );
        if (!boardRegion) {
          return null;
        }

        const scaleX = video.videoWidth / sampleWidth;
        const scaleY = video.videoHeight / sampleHeight;
        const targetPixels = Math.max(1, boxWidth * boxHeight);
        const trimmedBounds = trimmedBoardRegionBounds(
          boardRegion,
          sampleWidth,
          neutralDarkTarget
        );
        const boardWidth = Math.max(1, trimmedBounds.maxX - trimmedBounds.minX + 1);
        const boardHeight = Math.max(1, trimmedBounds.maxY - trimmedBounds.minY + 1);
        const x = trimmedBounds.minX * scaleX;
        const y = trimmedBounds.minY * scaleY;
        const width = boardWidth * scaleX;
        const height = boardHeight * scaleY;
        const greenCenterX = boardRegion.sumX / boardRegion.pixels;
        const greenCenterY = boardRegion.sumY / boardRegion.pixels;
        const targetCenterX = boxX + boxWidth / 2;
        const targetCenterY = boxY + boxHeight / 2;
        const centerOffsetX = (greenCenterX - targetCenterX) / boxWidth;
        const centerOffsetY = (greenCenterY - targetCenterY) / boxHeight;
        const centerDistance = Math.hypot(centerOffsetX, centerOffsetY);
        const centerScore = Math.max(0, 1 - centerDistance * 3.0);
        const greenPixelRatio = boardRegion.pixels / (sampleWidth * sampleHeight);
        const targetMatchingPixels = countRegionPixelsInBox(
          boardRegion.pixelsInRegion,
          boxX,
          boxY,
          boxRight,
          boxBottom,
          sampleWidth
        );
        const fillScore = Math.min(1, targetMatchingPixels / (targetPixels * 0.45));
        const presenceScore = Math.min(1, greenPixelRatio / BOARD_PRESENCE_PIXEL_RATIO);
        const sizeScore = Math.min(
          1,
          Math.min(boardWidth / boxWidth, boxWidth / boardWidth) *
            Math.min(boardHeight / boxHeight, boxHeight / boardHeight)
        );
        const confidence = Math.min(
          0.99,
          fillScore * 0.50 + centerScore * 0.35 + sizeScore * 0.15
        );

        return {
          x,
          y,
          width,
          height,
          areaRatio: (width * height) / (video.videoWidth * video.videoHeight),
          confidence,
          offsetX: centerOffsetX,
          offsetY: centerOffsetY,
          greenCenterX: greenCenterX * scaleX,
          greenCenterY: greenCenterY * scaleY,
          greenPixelRatio,
          presenceScore,
          fillScore,
          centerScore,
          sizeScore
        };
      }

      function updateSelectedColorBoardOverlay() {
        const video = document.getElementById("webcam-preview");
        if (!video || !video.videoWidth || !video.videoHeight) {
          clearBoardOverlay();
          return null;
        }

        const board = findBoardBySelectedColor(video);
        if (!board) {
          lastBoardBox = null;
          clearBoardOverlay();
          return null;
        }

        const smoothedBoard = smoothedBoardOverlay(board);
        lastBoardBox = smoothedBoard;
        drawBoardOverlay(smoothedBoard, board.confidence >= BOARD_MIN_CONFIDENCE);
        return board;
      }

      function boardPixelMatches(red, green, blue, targetRgb, targetHsl) {
        const color = rgbToHsl(red, green, blue);
        const redDelta = red - targetRgb.red;
        const greenDelta = green - targetRgb.green;
        const blueDelta = blue - targetRgb.blue;
        const rgbDistance = Math.sqrt(
          redDelta * redDelta +
            greenDelta * greenDelta +
            blueDelta * blueDelta
        );

        // White floors, rails, and glare can have unstable hue values. RGB
        // distance keeps those broad background areas from being counted as PCB.
        // Black and charcoal boards are often low-saturation gray under the
        // camera. Hue is unstable there, so match them with RGB/lightness.
        const targetIsNeutralDark = targetIsNeutralDarkBoard(targetHsl);

        if (targetIsNeutralDark) {
          const lightnessMin = Math.max(0, targetHsl.lightness - 0.22);
          const lightnessMax = Math.min(0.62, targetHsl.lightness + 0.15);
          return (
            rgbDistance <= 68 &&
            color.saturation <= 0.34 &&
            color.lightness >= lightnessMin &&
            color.lightness <= lightnessMax &&
            red < 150 &&
            green < 150 &&
            blue < 150
          );
        }

        return (
          rgbDistance <= 110 &&
          hueDistance(color.hue, targetHsl.hue) <= 42 &&
          color.saturation >= Math.max(0.10, targetHsl.saturation * 0.38) &&
          Math.abs(color.lightness - targetHsl.lightness) <= 0.36 &&
          red < 245 &&
          green < 245 &&
          blue < 245
        );
      }

      function targetIsNeutralDarkBoard(targetHsl) {
        return targetHsl.lightness < 0.50 && targetHsl.saturation < 0.18;
      }

      function largestBoardRegion(mask, width, height, neutralDarkTarget = false) {
        const visited = new Uint8Array(mask.length);
        let bestRegion = null;
        const stack = [];

        for (let startIndex = 0; startIndex < mask.length; startIndex += 1) {
          if (!mask[startIndex] || visited[startIndex]) {
            continue;
          }

          const startX = startIndex % width;
          const startY = Math.floor(startIndex / width);
          const region = {
            pixels: 0,
            minX: startX,
            minY: startY,
            maxX: startX,
            maxY: startY,
            sumX: 0,
            sumY: 0,
            pixelsInRegion: []
          };

          stack.length = 0;
          stack.push(startIndex);
          visited[startIndex] = 1;

          while (stack.length > 0) {
            const index = stack.pop();
            const x = index % width;
            const y = Math.floor(index / width);

            region.pixels += 1;
            region.sumX += x;
            region.sumY += y;
            region.minX = Math.min(region.minX, x);
            region.minY = Math.min(region.minY, y);
            region.maxX = Math.max(region.maxX, x);
            region.maxY = Math.max(region.maxY, y);
            region.pixelsInRegion.push(index);

            visitNeighbor(index - 1, x > 0);
            visitNeighbor(index + 1, x < width - 1);
            visitNeighbor(index - width, y > 0);
            visitNeighbor(index + width, y < height - 1);
          }

          if (
            regionLooksBoardSized(region, width, height, neutralDarkTarget) &&
            (!bestRegion || region.pixels > bestRegion.pixels)
          ) {
            bestRegion = region;
          }
        }

        if (!bestRegion) {
          return null;
        }

        const regionRatio = bestRegion.pixels / (width * height);
        if (regionRatio < BOARD_PRESENCE_PIXEL_RATIO) {
          return null;
        }

        return bestRegion;

        function visitNeighbor(index, inBounds) {
          if (!inBounds || visited[index] || !mask[index]) {
            return;
          }

          visited[index] = 1;
          stack.push(index);
        }
      }

      function regionLooksBoardSized(region, frameWidth, frameHeight, neutralDarkTarget) {
        const regionWidth = region.maxX - region.minX + 1;
        const regionHeight = region.maxY - region.minY + 1;
        const widthRatio = regionWidth / frameWidth;
        const heightRatio = regionHeight / frameHeight;
        const aspectRatio = regionWidth / Math.max(1, regionHeight);

        // Reject skinny vertical/horizontal machine parts. A PCB edge entering
        // frame can be partial, but it should still have meaningful width and
        // height compared with the camera view.
        if (neutralDarkTarget) {
          return (
            widthRatio >= 0.24 &&
            heightRatio >= 0.16 &&
            aspectRatio >= 0.70 &&
            aspectRatio <= 3.2
          );
        }

        return (
          widthRatio >= 0.08 &&
          heightRatio >= 0.08 &&
          aspectRatio >= 0.25 &&
          aspectRatio <= 5.0
        );
      }

      function trimmedBoardRegionBounds(region, imageWidth, neutralDarkTarget) {
        const regionWidth = region.maxX - region.minX + 1;
        const regionHeight = region.maxY - region.minY + 1;
        const columnCounts = new Array(regionWidth).fill(0);
        const rowCounts = new Array(regionHeight).fill(0);

        for (const pixelIndex of region.pixelsInRegion) {
          const x = pixelIndex % imageWidth;
          const y = Math.floor(pixelIndex / imageWidth);
          columnCounts[x - region.minX] += 1;
          rowCounts[y - region.minY] += 1;
        }

        const columnDensity = neutralDarkTarget ? 0.26 : 0.18;
        const rowDensity = neutralDarkTarget ? 0.30 : 0.18;
        const columnThreshold = Math.max(3, Math.round(regionHeight * columnDensity));
        const rowThreshold = Math.max(3, Math.round(regionWidth * rowDensity));
        const minColumn = firstThresholdIndex(columnCounts, columnThreshold);
        const maxColumn = lastThresholdIndex(columnCounts, columnThreshold);
        const minRow = firstThresholdIndex(rowCounts, rowThreshold);
        const maxRow = lastThresholdIndex(rowCounts, rowThreshold);

        if (minColumn === -1 || maxColumn === -1 || minRow === -1 || maxRow === -1) {
          return {
            minX: region.minX,
            minY: region.minY,
            maxX: region.maxX,
            maxY: region.maxY
          };
        }

        return {
          minX: region.minX + minColumn,
          minY: region.minY + minRow,
          maxX: region.minX + maxColumn,
          maxY: region.minY + maxRow
        };
      }

      function firstThresholdIndex(values, threshold) {
        for (let index = 0; index < values.length; index += 1) {
          if (values[index] >= threshold) {
            return index;
          }
        }

        return -1;
      }

      function lastThresholdIndex(values, threshold) {
        for (let index = values.length - 1; index >= 0; index -= 1) {
          if (values[index] >= threshold) {
            return index;
          }
        }

        return -1;
      }

      function countRegionPixelsInBox(regionPixels, boxX, boxY, boxRight, boxBottom, imageWidth) {
        let count = 0;

        for (const pixelIndex of regionPixels) {
          const x = pixelIndex % imageWidth;
          const y = Math.floor(pixelIndex / imageWidth);
          if (x >= boxX && x < boxRight && y >= boxY && y < boxBottom) {
            count += 1;
          }
        }

        return count;
      }

      function rgbToHsl(red, green, blue) {
        const r = red / 255;
        const g = green / 255;
        const b = blue / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const lightness = (max + min) / 2;
        const delta = max - min;

        if (delta === 0) {
          return { hue: 0, saturation: 0, lightness };
        }

        const saturation = delta / (1 - Math.abs(2 * lightness - 1));
        let hue;

        if (max === r) {
          hue = 60 * (((g - b) / delta) % 6);
        } else if (max === g) {
          hue = 60 * ((b - r) / delta + 2);
        } else {
          hue = 60 * ((r - g) / delta + 4);
        }

        if (hue < 0) {
          hue += 360;
        }

        return { hue, saturation, lightness };
      }

      function hueDistance(firstHue, secondHue) {
        const distance = Math.abs(firstHue - secondHue);
        return Math.min(distance, 360 - distance);
      }

      function resetSearchState() {
        searchIndex = 0;
        searchMoveInFlight = false;
        inspectionMode = "search";
      }

      async function initializeFullAreaSearch() {
        if (!axisBridgeConnected) {
          await connectAxis();
        }

        if (!axisBridgeConnected) {
          return;
        }

        try {
          appendTerminalLine("[SEARCH] moving axis to absolute X0 Y0 before full-area search");
          await postAxis("/axis/move-absolute", {
            x_mm: 0,
            y_mm: 0,
            feed_mm_min: SEARCH_FEED_MM_MIN
          });

          const response = await fetch(`${AXIS_BRIDGE_URL}/axis/status`);
          const payload = await response.json();
          const position = parseMachinePosition(payload.status);
          if (!position) {
            appendTerminalLine(`[ERROR] Could not read axis MPos from status: ${payload.status}`);
            return;
          }

          searchStartXmm = position.x;
          searchStartYmm = position.y;
          searchXmm = position.x;
          searchYmm = position.y;
          searchPattern = buildFullAreaSearchPattern();
          resetSearchState();
          const bounds = getSearchBounds();
          appendTerminalLine(
            `[SEARCH] start WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)} bounds=X${bounds.minX.toFixed(0)}..${bounds.maxX.toFixed(0)} Y${bounds.minY.toFixed(0)}..${bounds.maxY.toFixed(0)} targets=${searchPattern.length}`
          );
        } catch (error) {
          appendTerminalLine(`[ERROR] Search initialization failed: ${error.message}`);
        }
      }

      function updateAxisPositionFromStatus(status) {
        const position = parseMachinePosition(status);
        if (!position) {
          return null;
        }

        searchStartXmm = position.x;
        searchStartYmm = position.y;
        searchXmm = position.x;
        searchYmm = position.y;
        return position;
      }

      function parseMachinePosition(status) {
        const machineMatch = status.match(/MPos:([-0-9.]+),([-0-9.]+),([-0-9.]+)/);
        if (!machineMatch) {
          return null;
        }

        const machineX = Number(machineMatch[1]);
        const machineY = Number(machineMatch[2]);
        const machineZ = Number(machineMatch[3]);
        const offsetMatch = status.match(/WCO:([-0-9.]+),([-0-9.]+),([-0-9.]+)/);

        // GRBL reports MPos as raw machine position. After Set Zero, MPos will
        // still show the physical machine coordinate, while WCO stores the work
        // coordinate offset. The app's search targets use work coordinates, so
        // calculate WPos = MPos - WCO when WCO is available.
        if (offsetMatch) {
          return {
            x: machineX - Number(offsetMatch[1]),
            y: machineY - Number(offsetMatch[2]),
            z: machineZ - Number(offsetMatch[3])
          };
        }

        return {
          x: machineX,
          y: machineY,
          z: machineZ
        };
      }

      function formatAxisPositionForLog(status, position) {
        if (!position) {
          return status;
        }

        return `WPos X=${position.x.toFixed(3)} Y=${position.y.toFixed(3)} (${status})`;
      }

      function buildFullAreaSearchPattern() {
        // First trace the full outer square so zero-signal startup immediately
        // checks the search boundary. Then draw an X through the same area. If
        // neither pass finds the PCB, continue with broader area coverage.
        const bounds = getSearchBounds();
        const pattern = [[0, 0]];

        if (!bounds.requiresAxisTravel) {
          return pattern;
        }

        addAbsoluteSearchPoint(pattern, bounds.minX, bounds.minY, bounds);
        addAbsoluteSearchPoint(pattern, bounds.maxX, bounds.minY, bounds);
        addAbsoluteSearchPoint(pattern, bounds.maxX, bounds.maxY, bounds);
        addAbsoluteSearchPoint(pattern, bounds.minX, bounds.maxY, bounds);
        addAbsoluteSearchPoint(pattern, bounds.minX, bounds.minY, bounds);
        addAbsoluteSearchPoint(pattern, 0, 0);
        addAbsoluteSearchPoint(pattern, bounds.minX, bounds.minY, bounds);
        addAbsoluteSearchPoint(pattern, bounds.maxX, bounds.maxY, bounds);
        addAbsoluteSearchPoint(pattern, 0, 0);
        addAbsoluteSearchPoint(pattern, bounds.minX, bounds.maxY, bounds);
        addAbsoluteSearchPoint(pattern, bounds.maxX, bounds.minY, bounds);
        addAbsoluteSearchPoint(pattern, 0, 0);

        let leftToRight = true;
        for (let y = bounds.minY; y <= bounds.maxY; y += SEARCH_FAST_MOVE_MM) {
          if (leftToRight) {
            for (let x = bounds.minX; x <= bounds.maxX; x += SEARCH_FAST_MOVE_MM) {
              addAbsoluteSearchPoint(pattern, x, y, bounds);
            }
          } else {
            for (let x = bounds.maxX; x >= bounds.minX; x -= SEARCH_FAST_MOVE_MM) {
              addAbsoluteSearchPoint(pattern, x, y, bounds);
            }
          }
          leftToRight = !leftToRight;
        }

        const maxGridX = Math.ceil(
          Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX)) / SEARCH_MOVE_MM
        );
        const maxGridY = Math.ceil(
          Math.max(Math.abs(bounds.minY), Math.abs(bounds.maxY)) / SEARCH_MOVE_MM
        );
        const maxRadius = Math.max(maxGridX, maxGridY);

        for (let radius = 1; radius <= maxRadius; radius += 1) {
          for (let x = -radius + 1; x <= radius; x += 1) {
            addAbsoluteSearchPoint(pattern, x * SEARCH_MOVE_MM, -radius * SEARCH_MOVE_MM, bounds);
          }
          for (let y = -radius + 1; y <= radius; y += 1) {
            addAbsoluteSearchPoint(pattern, radius * SEARCH_MOVE_MM, y * SEARCH_MOVE_MM, bounds);
          }
          for (let x = radius - 1; x >= -radius; x -= 1) {
            addAbsoluteSearchPoint(pattern, x * SEARCH_MOVE_MM, radius * SEARCH_MOVE_MM, bounds);
          }
          for (let y = radius - 1; y >= -radius; y -= 1) {
            addAbsoluteSearchPoint(pattern, -radius * SEARCH_MOVE_MM, y * SEARCH_MOVE_MM, bounds);
          }
        }

        addAbsoluteSearchPoint(pattern, 0, 0);
        return pattern;
      }

      function addAbsoluteSearchPoint(pattern, xMm, yMm, bounds = getSearchBounds()) {
        xMm = clamp(xMm, bounds.minX, bounds.maxX);
        yMm = clamp(yMm, bounds.minY, bounds.maxY);
        const previous = pattern[pattern.length - 1];
        if (previous && previous[0] === xMm && previous[1] === yMm) {
          return;
        }

        pattern.push([xMm, yMm]);
      }

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      function cornerCorrectionMoveFromOffset(offset, sign) {
        const magnitude = Math.abs(offset);
        const scaledMaxStep = clamp(
          magnitude * CAPTURE_CORNER_MM_PER_OFFSET,
          CAPTURE_CORNER_MIN_STEP_MM,
          CAPTURE_CORNER_MAX_STEP_MM
        );
        const move = -offset * CAPTURE_CORNER_MM_PER_OFFSET * sign;
        return clamp(move, -scaledMaxStep, scaledMaxStep);
      }

      function drawBoardOverlay(board, ready) {
        const video = document.getElementById("webcam-preview");
        const overlay = document.getElementById("board-overlay");
        const rect = video.getBoundingClientRect();
        overlay.width = rect.width;
        overlay.height = rect.height;
        const context = overlay.getContext("2d");
        context.clearRect(0, 0, overlay.width, overlay.height);

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

        const x = offsetX + board.x / video.videoWidth * displayedWidth;
        const y = offsetY + board.y / video.videoHeight * displayedHeight;
        const width = board.width / video.videoWidth * displayedWidth;
        const height = board.height / video.videoHeight * displayedHeight;
        const centerX = offsetX + (board.x + board.width / 2) / video.videoWidth * displayedWidth;
        const centerY = offsetY + (board.y + board.height / 2) / video.videoHeight * displayedHeight;
        const greenX = offsetX + (board.greenCenterX || (board.x + board.width / 2)) / video.videoWidth * displayedWidth;
        const greenY = offsetY + (board.greenCenterY || (board.y + board.height / 2)) / video.videoHeight * displayedHeight;

        context.strokeStyle = ready ? "#00ff66" : "#f59e0b";
        context.lineWidth = 3;
        context.strokeRect(x, y, width, height);
        context.strokeStyle = "#38bdf8";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(centerX - 10, centerY);
        context.lineTo(centerX + 10, centerY);
        context.moveTo(centerX, centerY - 10);
        context.lineTo(centerX, centerY + 10);
        context.stroke();
        context.fillStyle = "#ff2d55";
        context.beginPath();
        context.arc(greenX, greenY, 7, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = "rgba(0, 0, 0, 0.75)";
        context.fillRect(x, Math.max(0, y - 22), 220, 22);
        context.fillStyle = ready ? "#00ff66" : "#f59e0b";
        context.font = "700 14px Consolas, monospace";
        const label = board.presenceOnly
          ? (ready ? "BOARD IN RANGE" : "BOARD SIGNAL")
          : (ready ? "PCB ALIGNED" : "ALIGNING");
        const score = board.presenceOnly ? board.presenceScore : board.confidence;
        context.fillText(`${label} ${Math.round(score * 100)}%`, x + 6, Math.max(16, y - 7));
      }

      function clearBoardOverlay() {
        const overlay = document.getElementById("board-overlay");
        const context = overlay.getContext("2d");
        context.clearRect(0, 0, overlay.width, overlay.height);
      }

      function folderNameForFile(folderName) {
        return folderName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "") || "images";
      }

