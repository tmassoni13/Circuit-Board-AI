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

        await postAxis("/axis/move", {
          x_mm: xMove,
          y_mm: yMove,
          feed_mm_min: SEARCH_FEED_MM_MIN
        });
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

        let edgeAlignSign = edge === "right" ? CAPTURE_RIGHT_SIGN_X : CAPTURE_BOTTOM_SIGN_Y;
        let previousAbsOffset = null;
        let missingEdgeFrames = 0;

        for (let step = 1; step <= CAPTURE_CORNER_ALIGN_MAX_STEPS;) {
          const board = findBoardBySelectedColor(video);
          if (!board) {
            missingEdgeFrames += 1;
            if (missingEdgeFrames === 1 || missingEdgeFrames % 5 === 0) {
              appendTerminalLine(
                `[${logPrefix}] waiting for visible board edge ${missingEdgeFrames}/${CAPTURE_CORNER_EDGE_WAIT_FRAMES}.`
              );
            }

            if (missingEdgeFrames >= CAPTURE_CORNER_EDGE_WAIT_FRAMES) {
              appendTerminalLine(`[${logPrefix}] cannot align ${edge} edge. No board edge is visible.`);
              return null;
            }

            await wait(CAPTURE_CORNER_EDGE_WAIT_MS);
            continue;
          }

          missingEdgeFrames = 0;
          const edgeOffset = visibleBoardEdgeOffset(board, video, edge);
          const absOffset = Math.abs(edgeOffset);

          if (
            previousAbsOffset !== null &&
            absOffset > previousAbsOffset + 0.01
          ) {
            edgeAlignSign *= -1;
            appendTerminalLine(
              `[${logPrefix}] ${edge} alignment direction reversed; offset got worse (${previousAbsOffset.toFixed(3)} -> ${absOffset.toFixed(3)})`
            );
          }

          if (Math.abs(edgeOffset) <= CAPTURE_CORNER_ALIGN_DEADBAND) {
            const position = await readAxisWorkPosition();
            appendTerminalLine(
              `[${logPrefix}] ${edge} edge aligned at WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}`
            );
            return position;
          }

          const correctionMove = cornerCorrectionMoveFromOffset(edgeOffset, edgeAlignSign);
          const xMove = edge === "right" ? correctionMove : 0;
          const yMove = edge === "bottom" ? correctionMove : 0;
          appendTerminalLine(
            `[${logPrefix}] ${edge} align ${step}/${CAPTURE_CORNER_ALIGN_MAX_STEPS} offset=${edgeOffset.toFixed(3)} moveX=${xMove.toFixed(2)}mm moveY=${yMove.toFixed(2)}mm`
          );
          const movePayload = await postAxis("/axis/move", {
            x_mm: xMove,
            y_mm: yMove,
            feed_mm_min: CAPTURE_CORNER_FEED_MM_MIN
          });
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
          previousAbsOffset = absOffset;
          step += 1;
        }

        appendTerminalLine(`[${logPrefix}] ${edge} alignment failed. Board edge never reached target.`);
        return null;
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

