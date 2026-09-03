async function captureBoardImageSet(options = {}) {
        lastCaptureFailureReason = "";
        const requireMachineRunning = options.requireMachineRunning !== false;
        const logPrefix = options.logPrefix || "CAPTURE";
        const alignFromCamera = options.alignFromCamera === true;
        const shouldAnalyze = options.analyze !== false && logPrefix !== "TEST CAPTURE";
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
          `[${logPrefix} PLAN] board=${settings.widthMm}x${settings.heightMm}mm fov=${settings.fovWidthMm}x${settings.fovHeightMm}mm overlap=${CAPTURE_OVERLAP_MM}mm tiles=${capturePlan.columns}x${capturePlan.rows} images=${capturePlan.imagesPerBoard}`
        );

        let previousCaptureTarget = null;
        const boardNumber = nextBoardNumber;
        const capturedImages = [];
        if (alignFromCamera && capturePlan.requiresAxisTravel) {
          const alignmentMode = captureAlignmentModeForSettings(settings);
          const alignedOrigin = await alignCameraForCaptureMode(logPrefix, alignmentMode);
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

          if (capturePlan.requiresAxisTravel) {
            if (alignFromCamera) {
              await moveToNextRelativeCapturePosition(previousCaptureTarget, target);
            } else {
              await moveAxisToCaptureTarget(target);
            }
          }

          const preCaptureSettleMs = target.imageNumber === 2
            ? CAPTURE_SECOND_IMAGE_PRE_SETTLE_MS
            : CAPTURE_PRE_IMAGE_SETTLE_MS;
          await wait(preCaptureSettleMs);

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
          await wait(CAPTURE_POST_IMAGE_SETTLE_MS);
        }

        nextBoardNumber += 1;
        nextImageNumberForBoard = 1;

        if (capturePlan.requiresAxisTravel) {
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

      async function moveToNextRelativeCapturePosition(previousTarget, nextTarget) {
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

        await moveAxisRelative(xMove, yMove, SEARCH_FEED_MM_MIN);
      }

      async function alignCameraForCaptureMode(logPrefix, alignmentMode) {
        if (alignmentMode === "none") {
          return readAxisWorkPosition();
        }

        if (alignmentMode === "bottom") {
          appendTerminalLine(`[${logPrefix}] board fits FOV width. Aligning bottom edge only.`);
          return alignCameraToVisibleBoardEdge(logPrefix, "bottom");
        }

        if (alignmentMode === "right") {
          appendTerminalLine(`[${logPrefix}] board fits FOV height. Aligning right edge only.`);
          return alignCameraToVisibleBoardEdge(logPrefix, "right");
        }

        appendTerminalLine(`[${logPrefix}] board exceeds FOV width and height. Aligning visible corner.`);
        const bottomAligned = await alignCameraToVisibleBoardEdge(logPrefix, "bottom");
        if (!bottomAligned) {
          return null;
        }

        return alignCameraToVisibleBoardEdge(logPrefix, "right");
      }

      async function alignCameraToVisibleBoardEdge(logPrefix, edge) {
        const video = document.getElementById("webcam-preview");
        if (!video.videoWidth || !video.videoHeight) {
          appendTerminalLine(`[${logPrefix}] cannot align ${edge} edge. Camera frame is not ready.`);
          return null;
        }

        clearBoardOverlay();
        let missingEdgeFrames = 0;

        for (let frame = 1; frame <= CAPTURE_CORNER_EDGE_WAIT_FRAMES; frame += 1) {
          const edgeReading = findSelectedColorBoardEdge(video, edge);
          if (!edgeReading) {
            missingEdgeFrames += 1;
            if (missingEdgeFrames === 1 || missingEdgeFrames % 5 === 0) {
              appendTerminalLine(
                `[${logPrefix}] waiting for visible board edge ${missingEdgeFrames}/${CAPTURE_CORNER_EDGE_WAIT_FRAMES}.`
              );
            }

            await wait(CAPTURE_CORNER_EDGE_WAIT_MS);
            continue;
          }

          const initialOffsetMm = edgeOffsetMm(edgeReading, edge);
          const toleranceMm = CAPTURE_EDGE_ALIGNMENT_TOLERANCE_MM;

          appendTerminalLine(
            `[${logPrefix}] ${edge} edge visible. offset=${initialOffsetMm.toFixed(1)}mm targetTolerance=${toleranceMm.toFixed(1)}mm`
          );

          if (Math.abs(initialOffsetMm) <= toleranceMm) {
            const position = await readAxisWorkPosition();
            appendTerminalLine(
              `[${logPrefix}] ${edge} edge already aligned at WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}`
            );
            return position;
          }

          const jumpMoveMm = signedEdgeCorrectionMove(initialOffsetMm, edge, CAPTURE_EDGE_INITIAL_JUMP_MM);
          appendTerminalLine(
            `[${logPrefix}] ${edge} edge coarse move ${axisMoveLog(edge, jumpMoveMm)}`
          );
          await moveAxisRelative(
            edge === "right" ? jumpMoveMm : 0,
            edge === "bottom" ? jumpMoveMm : 0,
            CAPTURE_CORNER_FEED_MM_MIN
          );
          await wait(CAPTURE_CORNER_SETTLE_MS);

          const correctedEdgeReading = findSelectedColorBoardEdge(video, edge);
          if (!correctedEdgeReading) {
            appendTerminalLine(`[${logPrefix}] cannot align ${edge} edge. Edge disappeared after coarse move.`);
            return null;
          }

          const correctedOffsetMm = edgeOffsetMm(correctedEdgeReading, edge);
          if (Math.abs(correctedOffsetMm) <= toleranceMm) {
            const position = await readAxisWorkPosition();
            appendTerminalLine(
              `[${logPrefix}] ${edge} edge aligned at WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}`
            );
            return position;
          }

          const autoCorrectDistanceMm = Math.min(
            Math.abs(correctedOffsetMm),
            CAPTURE_EDGE_AUTO_CORRECT_MAX_MM
          );
          const autoCorrectMoveMm = signedEdgeCorrectionMove(
            correctedOffsetMm,
            edge,
            autoCorrectDistanceMm
          );
          appendTerminalLine(
            `[${logPrefix}] ${edge} edge auto-correct offset=${correctedOffsetMm.toFixed(1)}mm ${axisMoveLog(edge, autoCorrectMoveMm)}`
          );
          const movePayload = await moveAxisRelative(
            edge === "right" ? autoCorrectMoveMm : 0,
            edge === "bottom" ? autoCorrectMoveMm : 0,
            CAPTURE_CORNER_FEED_MM_MIN
          );
          const finalMoveLine = Array.isArray(movePayload.lines)
            ? movePayload.lines[movePayload.lines.length - 1]
            : "";
          const measuredDelta = movePayload.delta || {};
          const measuredX = Number(measuredDelta.x_mm || 0).toFixed(2);
          const measuredY = Number(measuredDelta.y_mm || 0).toFixed(2);
          appendTerminalLine(
            `[${logPrefix}] axis move complete dX=${measuredX}mm dY=${measuredY}mm ${finalMoveLine}`
          );
          await wait(CAPTURE_CORNER_SETTLE_MS);

          const finalEdgeReading = findSelectedColorBoardEdge(video, edge);
          if (!finalEdgeReading) {
            appendTerminalLine(`[${logPrefix}] cannot align ${edge} edge. Edge disappeared after auto-correct.`);
            return null;
          }

          const finalOffsetMm = edgeOffsetMm(finalEdgeReading, edge);
          if (Math.abs(finalOffsetMm) <= toleranceMm) {
            const position = await readAxisWorkPosition();
            appendTerminalLine(
              `[${logPrefix}] ${edge} edge aligned at WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}`
            );
            return position;
          }

          appendTerminalLine(
            `[${logPrefix}] ${edge} edge still outside tolerance after auto-correct. offset=${finalOffsetMm.toFixed(1)}mm`
          );
          return null;
        }

        appendTerminalLine(`[${logPrefix}] cannot align ${edge} edge. No board edge is visible.`);
        return null;
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
              targetPixel: video.videoHeight * (1 - CAPTURE_BOTTOM_MARGIN_RATIO),
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
              targetPixel: video.videoWidth * (1 - CAPTURE_BOTTOM_MARGIN_RATIO),
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

