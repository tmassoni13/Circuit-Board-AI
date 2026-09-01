async function captureBoardImageSet(options = {}) {
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
          appendTerminalLine("[ERROR] Cannot run multi-image board capture. 2D axis is not connected.");
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
          const alignedOrigin = await alignCameraToVisibleBoardCorner(logPrefix);
          if (!alignedOrigin) {
            setMachineStatus("CORNER ALIGN FAILED", "error");
            return false;
          }
        }

        for (const target of capturePlan.positions) {
          if (requireMachineRunning && !machineRunning) {
            appendTerminalLine(`[${logPrefix} PLAN] stopped before capture sequence completed.`);
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
            appendTerminalLine(`[ERROR] Capture failed at image ${target.imageNumber}.`);
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

      async function alignCameraToVisibleBoardCorner(logPrefix) {
        const video = document.getElementById("webcam-preview");
        if (!video.videoWidth || !video.videoHeight) {
          appendTerminalLine(`[${logPrefix}] cannot align corner. Camera frame is not ready.`);
          return null;
        }

        let bottomAlignSign = CAPTURE_BOTTOM_SIGN_Y;
        let previousAbsOffset = null;

        for (let step = 1; step <= CAPTURE_CORNER_ALIGN_MAX_STEPS; step += 1) {
          const board = findGreenBoard(video);
          if (!board) {
            appendTerminalLine(`[${logPrefix}] cannot align corner. No board edge is visible.`);
            return null;
          }

          const yOffset = visibleBoardBottomOffset(board, video);
          const absOffset = Math.abs(yOffset);

          if (
            previousAbsOffset !== null &&
            absOffset > previousAbsOffset + 0.01
          ) {
            bottomAlignSign *= -1;
            appendTerminalLine(
              `[${logPrefix}] bottom alignment direction reversed; offset got worse (${previousAbsOffset.toFixed(3)} -> ${absOffset.toFixed(3)})`
            );
          }

          if (Math.abs(yOffset) <= CAPTURE_CORNER_ALIGN_DEADBAND) {
            const position = await readAxisWorkPosition();
            appendTerminalLine(
              `[${logPrefix}] bottom edge aligned at WPos X=${position.x.toFixed(1)} Y=${position.y.toFixed(1)}`
            );
            return position;
          }

          const yMove = cornerCorrectionMoveFromOffset(yOffset, bottomAlignSign);
          appendTerminalLine(
            `[${logPrefix}] bottom align ${step}/${CAPTURE_CORNER_ALIGN_MAX_STEPS} bottomOffset=${yOffset.toFixed(3)} moveY=${yMove.toFixed(2)}mm`
          );
          await postAxis("/axis/move", {
            x_mm: 0,
            y_mm: yMove,
            feed_mm_min: CAPTURE_CORNER_FEED_MM_MIN
          });
          await wait(CAPTURE_CORNER_SETTLE_MS);
          previousAbsOffset = absOffset;
        }

        appendTerminalLine(`[${logPrefix}] bottom alignment failed. Board bottom never reached target.`);
        return null;
      }

      function visibleBoardBottomOffset(board, video) {
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

