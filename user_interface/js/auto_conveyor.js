function startAutoBoardScan() {
        if (autoScanTimer !== null) {
          return;
        }

        stableBoardFrames = 0;
        missingBoardFrames = 0;
        boardPresenceFrames = 0;
        boardInRange = false;
        pendingBoardBox = null;
        boardWorkflowInProgress = false;
        waitingForNextBoard = false;
        lastBoardBox = null;
        capturedCurrentBoard = false;
        smoothedAxisOffsetX = 0;
        smoothedAxisOffsetY = 0;
        inspectionMode = "search";
        autoConveyorState = "searching";
        autoConveyorBusy = false;
        autoConveyorMoveDirection = "stopped";
        ignoreEndSensorUntilNextBoard = false;
        autoScanTimer = window.setInterval(scanForBoard, AUTO_CONVEYOR_POLL_INTERVAL_MS);
      }

      function stopAutoBoardScan() {
        if (autoScanTimer !== null) {
          window.clearInterval(autoScanTimer);
          autoScanTimer = null;
        }

        clearBoardOverlay();
        stableBoardFrames = 0;
        missingBoardFrames = 0;
        boardPresenceFrames = 0;
        boardInRange = false;
        pendingBoardBox = null;
        boardWorkflowInProgress = false;
        waitingForNextBoard = false;
        lastBoardBox = null;
        capturedCurrentBoard = false;
        smoothedAxisOffsetX = 0;
        smoothedAxisOffsetY = 0;
        inspectionMode = "search";
        searchMoveInFlight = false;
        autoConveyorState = "idle";
        autoConveyorBusy = false;
        autoConveyorMoveDirection = "stopped";
        ignoreEndSensorUntilNextBoard = false;
      }

      async function scanForBoard() {
        if (!machineRunning || autoConveyorBusy) {
          return;
        }

        autoConveyorBusy = true;
        try {
          await runSensorDrivenBoardFlow();
        } catch (error) {
          appendTerminalLine(`[AUTO ERROR] ${error.message}`);
          setMachineStatus("AUTO ERROR", "error");
          await allConveyorRelaysOff({ writeLog: false });
        } finally {
          autoConveyorBusy = false;
        }
      }

      async function runSensorDrivenBoardFlow() {
        const payload = await readConveyorIoStatusForTransfer();
        if (!payload) {
          setMachineStatus("CONVEYOR IO ERROR", "error");
          return;
        }

        const startDetected = sensorIsDetected(payload.sensors, CONVEYOR_START_SENSOR_CHANNEL);
        const cameraDetected = sensorIsDetected(payload.sensors, CONVEYOR_CAMERA_SENSOR_CHANNEL);
        const endDetected = sensorIsDetected(payload.sensors, CONVEYOR_END_SENSOR_CHANNEL);

        if (autoConveyorState === "searching") {
          if (cameraDetected) {
            ignoreEndSensorUntilNextBoard = false;
            await stopAutoConveyorMotion();
            appendTerminalLine("[BOARD] board detected at camera sensor. Waiting for board to settle.");
            if (!await waitForBoardAtCameraSettle()) {
              return;
            }
            await beginBoardWorkflow(null);
            return;
          }

          if (startDetected) {
            ignoreEndSensorUntilNextBoard = false;
            await beginAutoConveyorMove("forward", "camera", "start sensor detected");
            return;
          }

          if (endDetected && !startDetected && !ignoreEndSensorUntilNextBoard) {
            await beginAutoConveyorMove("reverse", "camera", "end sensor detected");
            return;
          }

          if (!endDetected) {
            ignoreEndSensorUntilNextBoard = false;
          }

          setMachineStatus("WAITING FOR BOARD", "searching");
          return;
        }

        if (autoConveyorState === "moving_to_camera") {
          if (cameraDetected) {
            await stopAutoConveyorMotion();
            appendTerminalLine("[BOARD] board reached camera sensor. Waiting for board to settle.");
            if (!await waitForBoardAtCameraSettle()) {
              return;
            }
            await beginBoardWorkflow(null);
          }
          return;
        }

        if (autoConveyorState === "moving_to_end") {
          if (endDetected) {
            await stopAutoConveyorMotion();
            autoConveyorState = "searching";
            capturedCurrentBoard = false;
            waitingForNextBoard = false;
            ignoreEndSensorUntilNextBoard = true;
            appendTerminalLine("[BOARD] board reached end sensor. Ready for next board at Start or Camera.");
            setMachineStatus("WAITING FOR BOARD", "searching");
          }
          return;
        }

        if (autoConveyorState === "capture_error") {
          await stopAutoConveyorMotion();
          return;
        }
      }

      async function beginAutoConveyorMove(direction, target, reason) {
        if (autoConveyorMoveDirection === direction && autoConveyorState === `moving_to_${target}`) {
          return;
        }

        autoConveyorState = `moving_to_${target}`;
        autoConveyorMoveDirection = direction;
        setMachineStatus(target === "camera" ? "MOVING TO CAMERA" : "MOVING TO END", "searching");
        appendTerminalLine(`[CONVEYOR] ${reason}. Moving ${direction} to ${target} sensor.`);
        await allConveyorRelaysOff({ keepSensorTransferState: true, writeLog: false });
        await setConveyorRelay(direction === "forward" ? 1 : 2, true);
      }

      async function stopAutoConveyorMotion() {
        autoConveyorMoveDirection = "stopped";
        await allConveyorRelaysOff({ keepSensorTransferState: true, writeLog: false });
      }

      async function waitForBoardAtCameraSettle() {
        setMachineStatus("BOARD SETTLING", "searching");
        await wait(CAMERA_SENSOR_SETTLE_MS);
        if (!machineRunning) {
          lastCaptureFailureReason = "machine was stopped during board settle";
          return false;
        }

        return true;
      }

      async function beginBoardWorkflow(board) {
        if (boardWorkflowInProgress || capturedCurrentBoard) {
          return;
        }

        const settings = readBoardSettings();
        const capturePlan = buildBoardCapturePlan(settings);
        boardWorkflowInProgress = true;
        capturedCurrentBoard = true;
        autoConveyorState = "capturing";

        try {
          if (!capturePlan.requiresAxisTravel) {
            appendTerminalLine("[BOARD] board fits inside FOV. Holding X0 Y0 for single image.");
            const captureComplete = await captureBoardImageSet({ awaitAnalysis: false });
            if (!captureComplete) {
              await holdBoardAtCameraAfterCaptureFailure();
              return;
            }
            await moveCapturedBoardToEnd();
            return;
          }

          appendTerminalLine(
            `[BOARD] large board requires ${capturePlan.columns}x${capturePlan.rows} capture plan. Starting camera corner alignment.`
          );
          setMachineStatus("ALIGNING CORNER", "searching");

          const captureComplete = await captureBoardImageSet({
            requireMachineRunning: true,
            logPrefix: "AUTO CAPTURE",
            alignFromCamera: true,
            awaitAnalysis: false
          });
          if (!captureComplete) {
            await holdBoardAtCameraAfterCaptureFailure();
            return;
          }
          await moveCapturedBoardToEnd();
        } finally {
          boardWorkflowInProgress = false;
        }
      }

      async function holdBoardAtCameraAfterCaptureFailure() {
        autoConveyorState = "capture_error";
        autoConveyorMoveDirection = "stopped";
        waitingForNextBoard = false;
        appendTerminalLine(`[BOARD] Imaging did not complete. Board held at camera sensor. Reason: ${lastCaptureFailureReason || "unknown capture failure"}.`);
        setMachineStatus("CAPTURE ERROR", "error");
        await stopAutoConveyorMotion();
      }

      async function moveCapturedBoardToEnd() {
        waitingForNextBoard = true;
        appendTerminalLine("[BOARD] Imaging complete. Moving board to end sensor while Gemini analyzes in background.");
        await beginAutoConveyorMove("forward", "end", "image capture complete");
      }

