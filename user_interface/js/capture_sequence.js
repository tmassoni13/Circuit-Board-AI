async function captureBoardImageSet(options = {}) {
        lastCaptureFailureReason = "";
        const requireMachineRunning = options.requireMachineRunning !== false;
        const logPrefix = options.logPrefix || "CAPTURE";
        const alignFromCamera = options.alignFromCamera === true;
        const shouldAnalyze = options.analyze !== false && logPrefix !== "TEST CAPTURE";
        const cancelToken = captureCancelToken;
        const settings = readBoardSettings();
        const initialCapturePlan = buildBoardCapturePlan(settings, "center");
        const capturePlan = alignFromCamera && initialCapturePlan.requiresAxisTravel
          ? buildBoardCapturePlan(settings, "corner")
          : initialCapturePlan;

        if (!axisBridgeConnected && capturePlan.requiresAxisTravel) {
          lastCaptureFailureReason = "2D axis is not connected for multi-image capture";
          appendTerminalLine(`[ERROR] Cannot run multi-image board capture. ${lastCaptureFailureReason}.`);
          return false;
        }

        setMachineStatus("CAPTURING", "running");
        appendTerminalLine(
          `[${logPrefix} PLAN] board=${settings.widthMm}x${settings.heightMm}mm fov=${settings.fovWidthMm}x${settings.fovHeightMm}mm step=${capturePlan.useFullFovStep ? `full FOV + ${CAPTURE_MULTI_IMAGE_EXTRA_STEP_MM}mm` : `${CAPTURE_OVERLAP_MM}mm overlap`} tiles=${capturePlan.columns}x${capturePlan.rows} images=${capturePlan.imagesPerBoard}`
        );

        let previousCaptureTarget = null;
        const boardNumber = nextBoardNumber;
        const capturedImages = [];
        if (alignFromCamera && capturePlan.requiresAxisTravel) {
          if (captureWasCanceled(cancelToken, requireMachineRunning)) {
            return false;
          }
          const alignmentMode = captureAlignmentModeForSettings(settings);
          const alignedOrigin = await alignCameraForCaptureMode(logPrefix, alignmentMode, cancelToken, requireMachineRunning);
          if (!alignedOrigin) {
            lastCaptureFailureReason = `${alignmentMode} alignment failed`;
            setMachineStatus("ALIGNMENT FAILED", "error");
            return false;
          }
        }

        for (const target of capturePlan.positions) {
          if (requireMachineRunning && !machineRunning) {
            lastCaptureFailureReason = "machine was stopped before capture sequence completed";
            appendTerminalLine(`[${logPrefix} PLAN] ${lastCaptureFailureReason}.`);
            return false;
          }

          if (captureWasCanceled(cancelToken, requireMachineRunning)) {
            return false;
          }

          if (capturePlan.requiresAxisTravel) {
            if (alignFromCamera) {
              await moveToNextRelativeCapturePosition(previousCaptureTarget, target, cancelToken, requireMachineRunning);
            } else {
              if (captureWasCanceled(cancelToken, requireMachineRunning)) {
                return false;
              }
              await moveAxisToCaptureTarget(target);
            }
          }

          const preCaptureSettleMs = target.imageNumber === 2
            ? CAPTURE_SECOND_IMAGE_PRE_SETTLE_MS
            : CAPTURE_PRE_IMAGE_SETTLE_MS;
          if (!await waitForCapture(preCaptureSettleMs, cancelToken, requireMachineRunning)) {
            return false;
          }

          const blob = await captureStillBlob();
          if (!blob) {
            lastCaptureFailureReason = `camera capture failed at image ${target.imageNumber}`;
            appendTerminalLine(`[ERROR] ${lastCaptureFailureReason}.`);
            setMachineStatus("ERROR", "error");
            return false;
          }

          const imageName = capturePlan.imagesPerBoard <= 1
            ? String(boardNumber)
            : `${boardNumber}.${target.imageNumber}`;
          addImageToLog(blob, imageName, autoCaptureFolderName);
          capturedImages.push({ name: imageName, blob });
          appendTerminalLine(
            `[${logPrefix}] board ${boardNumber} image ${target.imageNumber}/${capturePlan.imagesPerBoard} dX=${target.xMm.toFixed(1)} dY=${target.yMm.toFixed(1)}`
          );
          previousCaptureTarget = target;
          if (!await waitForCapture(CAPTURE_POST_IMAGE_SETTLE_MS, cancelToken, requireMachineRunning)) {
            return false;
          }
        }

        nextBoardNumber += 1;
        nextImageNumberForBoard = 1;

        if (capturePlan.requiresAxisTravel) {
          if (captureWasCanceled(cancelToken, requireMachineRunning)) {
            return false;
          }
          await moveAxisToCaptureTarget({ xMm: 0, yMm: 0, imageNumber: 0 });
        }

        if (shouldAnalyze) {
          const folder = getImageFolder(autoCaptureFolderName);
          const analysisPromise = analyzeBoardImages(
            boardNumber,
            capturedImages,
            logPrefix,
            folder.promptNote || "",
            { updateStatus: options.awaitAnalysis !== false }
          );
          if (options.awaitAnalysis !== false) {
            await analysisPromise;
          }
        } else {
          setMachineStatus("BOARD CAPTURED", "running");
        }

        return true;
      }

      async function testCapturePositions() {
        if (!axisBridgeConnected) {
          await connectAxis();
        }

        if (!axisBridgeConnected) {
          appendTerminalLine("[ERROR] Cannot test scan. 2D axis is not connected.");
          return;
        }

        try {
          setMachineStatus("TEST CAPTURE", "searching");
          await captureBoardImageSet({
            requireMachineRunning: false,
            logPrefix: "TEST CAPTURE",
            alignFromCamera: true
          });
          appendTerminalLine("[TEST CAPTURE] returned to original X0 Y0.");
          setMachineStatus(machineRunning ? "SEARCHING FOR BOARD" : "OFF", machineRunning ? "searching" : "idle");
        } catch (error) {
          appendTerminalLine(`[ERROR] Test capture failed: ${error.message}`);
          try {
            await moveAxisToCaptureTarget({ xMm: 0, yMm: 0, imageNumber: 0 });
            appendTerminalLine("[TEST CAPTURE] returned to X0 Y0 after error.");
          } catch (returnError) {
            appendTerminalLine(`[ERROR] Could not return to X0 Y0: ${returnError.message}`);
          }
          setMachineStatus("AXIS ERROR", "error");
        }
      }

      async function moveToNextRelativeCapturePosition(previousTarget, nextTarget, cancelToken, requireMachineRunning) {
        // After visual alignment, the current camera position is image 1.
        // Every later image is just the relative distance from the previous
        // planned tile. This avoids tying the scan sequence to the original
        // startup zero; zero is only used for the final return home.
        if (!previousTarget) {
          appendTerminalLine("[CAPTURE MOVE] image 1 uses current aligned position.");
          return;
        }

        const xMove = (nextTarget.xMm - previousTarget.xMm) * CAPTURE_SCAN_SIGN_X;
        const yMove = (nextTarget.yMm - previousTarget.yMm) * CAPTURE_SCAN_SIGN_Y;

        appendTerminalLine(
          `[CAPTURE MOVE] relative X=${xMove.toFixed(1)}mm Y=${yMove.toFixed(1)}mm`
        );

        if (captureWasCanceled(cancelToken, requireMachineRunning)) {
          return;
        }

        await moveAxisRelative(xMove, yMove, SEARCH_FEED_MM_MIN);
      }

      async function ensureSmallBoardContainedBeforeCapture(cancelToken, requireMachineRunning = true) {
        const video = document.getElementById("webcam-preview");
        if (!video.videoWidth || !video.videoHeight) {
          appendTerminalLine("[BOARD] containment check skipped. Camera frame is not ready.");
          return true;
        }

        if (!axisBridgeConnected) {
          await connectAxis();
        }

        if (!axisBridgeConnected) {
          appendTerminalLine("[BOARD] containment correction skipped. 2D axis is not connected.");
          return true;
        }

        for (let attempt = 0; attempt <= SMALL_BOARD_CONTAINMENT_MAX_JOGS; attempt += 1) {
          if (captureWasCanceled(cancelToken, requireMachineRunning)) {
            return false;
          }

          const board = findBoardBySelectedColor(video);
          if (!board) {
            appendTerminalLine("[BOARD] containment check skipped. Board color was not visible.");
            return true;
          }

          const correction = smallBoardContainmentCorrection(board, video);
          if (!correction.needsMove) {
            appendTerminalLine("[BOARD] board fully contained in camera FOV.");
            return true;
          }

          if (attempt >= SMALL_BOARD_CONTAINMENT_MAX_JOGS) {
            appendTerminalLine(
              `[BOARD] board still near FOV edge after ${SMALL_BOARD_CONTAINMENT_MAX_JOGS} containment jogs. Capturing from current position.`
            );
            return true;
          }

          appendTerminalLine(
            `[BOARD] board not fully contained. Containment jog X=${correction.xMm.toFixed(1)}mm Y=${correction.yMm.toFixed(1)}mm.`
          );
          await moveAxisRelative(correction.xMm, correction.yMm, SEARCH_FEED_MM_MIN);
          if (!await waitForCapture(SMALL_BOARD_CONTAINMENT_SETTLE_MS, cancelToken, requireMachineRunning)) {
            return false;
          }
        }

        return true;
      }

      function smallBoardContainmentCorrection(board, video) {
        const marginX = video.videoWidth * SMALL_BOARD_CONTAINMENT_MARGIN_RATIO;
        const marginY = video.videoHeight * SMALL_BOARD_CONTAINMENT_MARGIN_RATIO;
        const boardRight = board.x + board.width;
        const boardBottom = board.y + board.height;
        let xMm = 0;
        let yMm = 0;

        if (board.x <= marginX) {
          xMm = -SMALL_BOARD_CONTAINMENT_JOG_MM;
        } else if (boardRight >= video.videoWidth - marginX) {
          xMm = SMALL_BOARD_CONTAINMENT_JOG_MM;
        }

        if (board.y <= marginY) {
          yMm = SMALL_BOARD_CONTAINMENT_JOG_MM;
        } else if (boardBottom >= video.videoHeight - marginY) {
          yMm = -SMALL_BOARD_CONTAINMENT_JOG_MM;
        }

        return {
          needsMove: xMm !== 0 || yMm !== 0,
          xMm,
          yMm
        };
      }

      async function alignCameraForCaptureMode(logPrefix, alignmentMode, cancelToken, requireMachineRunning) {
        if (alignmentMode === "none") {
          return readAxisWorkPosition();
        }

        if (alignmentMode === "bottom") {
          appendTerminalLine(`[${logPrefix}] board fits FOV width. Aligning bottom edge only.`);
          return alignCameraToVisibleBoardEdge(logPrefix, "bottom", cancelToken, requireMachineRunning);
        }

        appendTerminalLine(`[${logPrefix}] right edge alignment skipped. Operator-set right side is being used.`);
        return readAxisWorkPosition();
      }

      async function alignCameraToVisibleBoardEdge(logPrefix, edge, cancelToken, requireMachineRunning) {
        const video = document.getElementById("webcam-preview");
        if (!video.videoWidth || !video.videoHeight) {
          appendTerminalLine(`[${logPrefix}] cannot align ${edge} edge. Camera frame is not ready.`);
          return null;
        }

        clearBoardOverlay();
        let edgeReading = findSelectedColorBoardEdge(video, edge);
        let searchMoves = 0;

        while (!edgeReading && searchMoves < CAPTURE_EDGE_MAX_SEARCH_MOVES) {
          if (captureWasCanceled(cancelToken, requireMachineRunning)) {
            return null;
          }

          const searchMoveMm = missingEdgeSearchMove(edge);
          searchMoves += 1;
          appendTerminalLine(
            `[${logPrefix}] no ${edge} edge visible. Search move ${searchMoves}/${CAPTURE_EDGE_MAX_SEARCH_MOVES} ${axisMoveLog(edge, searchMoveMm)}.`
          );
          await moveAxisRelative(
            edge === "right" ? searchMoveMm : 0,
            edge === "bottom" ? searchMoveMm : 0,
            CAPTURE_CORNER_FEED_MM_MIN
          );
          if (!await waitForCapture(CAPTURE_EDGE_SEARCH_SETTLE_MS, cancelToken, requireMachineRunning)) {
            return null;
          }
          edgeReading = findSelectedColorBoardEdge(video, edge);
        }

        if (captureWasCanceled(cancelToken, requireMachineRunning)) {
          return null;
        }

        if (!edgeReading) {
          const position = await readAxisWorkPosition();
          appendTerminalLine(
            `[${logPrefix}] no ${edge} edge found after ${CAPTURE_EDGE_MAX_SEARCH_MOVES} search moves. Continuing from WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}.`
          );
          return position;
        }

        const offsetMm = edgeOffsetMm(edgeReading);
        const toleranceMm = CAPTURE_EDGE_ALIGNMENT_TOLERANCE_MM;
        appendTerminalLine(
          `[${logPrefix}] ${edge} edge found. offset=${offsetMm.toFixed(1)}mm targetTolerance=${toleranceMm.toFixed(1)}mm.`
        );

        if (Math.abs(offsetMm) < 1) {
          const position = await readAxisWorkPosition();
          appendTerminalLine(
            `[${logPrefix}] ${edge} edge aligned at WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}`
          );
          return position;
        }

        const autoCorrectDistanceMm = Math.abs(offsetMm);
        const autoCorrectMoveMm = signedEdgeCorrectionMove(
          offsetMm,
          edge,
          autoCorrectDistanceMm
        );
        appendTerminalLine(
          `[${logPrefix}] ${edge} edge correction to FOV edge ${axisMoveLog(edge, autoCorrectMoveMm)}`
        );
        if (captureWasCanceled(cancelToken, requireMachineRunning)) {
          return null;
        }
        await moveAxisRelative(
          edge === "right" ? autoCorrectMoveMm : 0,
          edge === "bottom" ? autoCorrectMoveMm : 0,
          CAPTURE_CORNER_FEED_MM_MIN
        );
        if (!await waitForCapture(CAPTURE_CORNER_SETTLE_MS, cancelToken, requireMachineRunning)) {
          return null;
        }

        const finalEdgeReading = findSelectedColorBoardEdge(video, edge);
        if (!finalEdgeReading) {
          const position = await readAxisWorkPosition();
          appendTerminalLine(
            `[${logPrefix}] ${edge} edge moved to camera boundary at WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}`
          );
          return position;
        }

        const finalOffsetMm = edgeOffsetMm(finalEdgeReading);
        if (Math.abs(finalOffsetMm) <= CAPTURE_EDGE_ALIGNMENT_TOLERANCE_MM) {
          const position = await readAxisWorkPosition();
          appendTerminalLine(
            `[${logPrefix}] ${edge} edge aligned at WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}`
          );
          return position;
        }

        appendTerminalLine(
          `[${logPrefix}] ${edge} edge still outside tolerance after correction. Continuing anyway. offset=${finalOffsetMm.toFixed(1)}mm`
        );
        return readAxisWorkPosition();
      }

      function captureWasCanceled(cancelToken, requireMachineRunning = true) {
        const tokenWasCanceled = captureCancelToken !== cancelToken;
        const stoppedDuringAutoRun = requireMachineRunning && !machineRunning;

        if (tokenWasCanceled || stoppedDuringAutoRun) {
          lastCaptureFailureReason = "machine was stopped during capture sequence";
          if (lastCaptureCancelLogToken !== captureCancelToken) {
            appendTerminalLine("[CAPTURE] stopped. Capture sequence canceled.");
            lastCaptureCancelLogToken = captureCancelToken;
          }
          return true;
        }

        return false;
      }

      async function waitForCapture(milliseconds, cancelToken, requireMachineRunning = true) {
        const intervalMs = 50;
        const deadline = Date.now() + milliseconds;

        while (Date.now() < deadline) {
          if (captureWasCanceled(cancelToken, requireMachineRunning)) {
            return false;
          }

          await wait(Math.min(intervalMs, deadline - Date.now()));
        }

        return !captureWasCanceled(cancelToken, requireMachineRunning);
      }

      function findSelectedColorBoardEdge(video, edge) {
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
        const sampleWidth = 320;
        const sampleHeight = Math.max(1, Math.round(sampleWidth * video.videoHeight / video.videoWidth));
        const canvas = document.createElement("canvas");
        canvas.width = sampleWidth;
        canvas.height = sampleHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(video, 0, 0, sampleWidth, sampleHeight);
        const image = context.getImageData(0, 0, sampleWidth, sampleHeight);
        const data = image.data;
        const rowCounts = new Array(sampleHeight).fill(0);
        const columnCounts = new Array(sampleWidth).fill(0);

        for (let y = 0; y < sampleHeight; y += 1) {
          for (let x = 0; x < sampleWidth; x += 1) {
            const offset = (y * sampleWidth + x) * 4;
            if (boardPixelMatches(data[offset], data[offset + 1], data[offset + 2], targetRgb, targetHsl)) {
              rowCounts[y] += 1;
              columnCounts[x] += 1;
            }
          }
        }

        return edge === "right"
          ? findRightColorToRandomEdge(columnCounts, sampleWidth, sampleHeight, video, settings)
          : findBottomColorToRandomEdge(rowCounts, sampleWidth, sampleHeight, video, settings);
      }

      function findBottomColorToRandomEdge(rowCounts, sampleWidth, sampleHeight, video, settings) {
        const minBoardPixels = Math.max(10, Math.round(sampleWidth * 0.12));
        const belowRandomPixels = Math.round(sampleWidth * 0.06);
        const windowRows = Math.max(2, Math.round(sampleHeight * 0.012));

        for (let y = sampleHeight - windowRows - 1; y >= windowRows; y -= 1) {
          const aboveColor = averageCounts(rowCounts, y - windowRows, y);
          const belowColor = averageCounts(rowCounts, y + 1, y + 1 + windowRows);
          if (aboveColor >= minBoardPixels && belowColor <= belowRandomPixels) {
            return {
              edgePixel: y * (video.videoHeight / sampleHeight),
              targetPixel: video.videoHeight - 1,
              pixelsPerMm: video.videoHeight / settings.fovHeightMm
            };
          }
        }

        return null;
      }

      function findRightColorToRandomEdge(columnCounts, sampleWidth, sampleHeight, video, settings) {
        const minBoardPixels = Math.max(10, Math.round(sampleHeight * 0.12));
        const outsideRandomPixels = Math.round(sampleHeight * 0.06);
        const windowColumns = Math.max(2, Math.round(sampleWidth * 0.012));

        for (let x = sampleWidth - windowColumns - 1; x >= windowColumns; x -= 1) {
          const leftColor = averageCounts(columnCounts, x - windowColumns, x);
          const rightColor = averageCounts(columnCounts, x + 1, x + 1 + windowColumns);
          if (leftColor >= minBoardPixels && rightColor <= outsideRandomPixels) {
            return {
              edgePixel: x * (video.videoWidth / sampleWidth),
              targetPixel: video.videoWidth - 1,
              pixelsPerMm: video.videoWidth / settings.fovWidthMm
            };
          }
        }

        return null;
      }

      function averageCounts(counts, startIndex, endIndex) {
        const start = Math.max(0, startIndex);
        const end = Math.min(counts.length - 1, endIndex);
        let total = 0;
        let count = 0;

        for (let index = start; index <= end; index += 1) {
          total += counts[index];
          count += 1;
        }

        return count ? total / count : 0;
      }

      function edgeOffsetMm(edgeReading) {
        return (edgeReading.edgePixel - edgeReading.targetPixel) / edgeReading.pixelsPerMm;
      }

      function signedEdgeCorrectionMove(offsetMm, edge, distanceMm) {
        const sign = edge === "right" ? CAPTURE_RIGHT_SIGN_X : CAPTURE_BOTTOM_SIGN_Y;
        return offsetMm < 0 ? distanceMm * sign : -distanceMm * sign;
      }

      function missingEdgeSearchMove(edge) {
        return edge === "right"
          ? CAPTURE_EDGE_NO_EDGE_SEARCH_MM * CAPTURE_RIGHT_SIGN_X
          : -CAPTURE_EDGE_NO_EDGE_SEARCH_MM * CAPTURE_BOTTOM_SIGN_Y;
      }

      function axisMoveLog(edge, moveMm) {
        return edge === "right"
          ? `moveX=${moveMm.toFixed(1)}mm`
          : `moveY=${moveMm.toFixed(1)}mm`;
      }

      function visibleBoardEdgeOffset(board, video, edge) {
        if (edge === "right") {
          const boardRight = board.x + board.width;
          const targetRight = video.videoWidth * (1 - CAPTURE_BOTTOM_MARGIN_RATIO);
          return (boardRight - targetRight) / video.videoWidth;
        }

        const boardBottom = board.y + board.height;
        const targetBottom = video.videoHeight * (1 - CAPTURE_BOTTOM_MARGIN_RATIO);
        return (boardBottom - targetBottom) / video.videoHeight;
      }

      async function readAxisWorkPosition() {
        const response = await fetch(`${AXIS_BRIDGE_URL}/axis/status`);
        if (!response.ok) {
          throw new Error(`axis status HTTP ${response.status}`);
        }

        const payload = await response.json();
        const position = parseMachinePosition(payload.status);
        if (!position) {
          throw new Error(`could not parse axis position: ${payload.status}`);
        }

        return position;
      }

      async function moveAxisToCaptureTarget(target) {
        await postAxis("/axis/move-absolute", {
          x_mm: target.xMm,
          y_mm: target.yMm,
          feed_mm_min: SEARCH_FEED_MM_MIN
        });
      }

