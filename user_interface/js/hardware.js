function getSearchBounds() {
        const settings = readBoardSettings();
        const halfTravelX = Math.max(0, (settings.widthMm - settings.fovWidthMm) / 2);
        const halfTravelY = Math.max(0, (settings.heightMm - settings.fovHeightMm) / 2);

        return {
          minX: clamp(-halfTravelX, AXIS_ABSOLUTE_MIN_X_MM, AXIS_ABSOLUTE_MAX_X_MM),
          maxX: clamp(halfTravelX, AXIS_ABSOLUTE_MIN_X_MM, AXIS_ABSOLUTE_MAX_X_MM),
          minY: clamp(-halfTravelY, AXIS_ABSOLUTE_MIN_Y_MM, AXIS_ABSOLUTE_MAX_Y_MM),
          maxY: clamp(halfTravelY, AXIS_ABSOLUTE_MIN_Y_MM, AXIS_ABSOLUTE_MAX_Y_MM),
          widthMm: settings.widthMm,
          heightMm: settings.heightMm,
          fovWidthMm: settings.fovWidthMm,
          fovHeightMm: settings.fovHeightMm,
          requiresAxisTravel: halfTravelX > 0 || halfTravelY > 0
        };
      }

      async function startMachine() {
        setMachineRunning(true);
        setMachineStatus("CHECKING AXIS", "searching");
        appendTerminalLine("[SYSTEM] Auto mode starting. Calibrating camera view.");

        const axisReady = await ensureAxisConnectedForStart();
        if (!axisReady) {
          machineRunning = false;
          setStartupControlMode("failure");
          setMachineStatus("2D AXIS NOT CONNECTED", "error");
          appendTerminalLine("[ERROR] 2D axis not connected. Start aborted.");
          return;
        }

        setMachineStatus("2D AXIS CONNECTED", "running");
        await wait(350);

        setMachineStatus("SETTING AXIS ZERO", "searching");
        const zeroReady = await setAxisZero();
        if (!zeroReady) {
          machineRunning = false;
          setStartupControlMode("failure");
          setMachineStatus("AXIS ZERO FAILED", "error");
          appendTerminalLine("[ERROR] Could not set current camera position to X0 Y0. Start aborted.");
          return;
        }

        await wait(350);

        const cameraReady = await ensureCameraConnectedForStart();
        if (!cameraReady) {
          machineRunning = false;
          setStartupControlMode("failure");
          setMachineStatus("CAMERA NOT CONNECTED", "error");
          appendTerminalLine("[ERROR] Camera not connected. Start aborted.");
          return;
        }

        setMachineStatus("CAMERA CONNECTED", "running");
        await wait(350);

        setMachineStatus("CALIBRATING", "searching");
        await initializeFullAreaSearch();
        window.setTimeout(() => {
          setMachineStatus("SEARCHING FOR BOARD", "searching");
          startAutoBoardScan();
        }, 500);
      }

      function stopMachine() {
        setMachineRunning(false);
        setMachineStatus("SHUTTING DOWN", "searching");
        stopAutoBoardScan();
        axisMoveInFlight = false;
        searchMoveInFlight = false;
        inspectionMode = "search";
        stopAxis();
        allConveyorRelaysOff({ writeLog: false });
        appendTerminalLine("[SYSTEM] Stop requested. Motion/scanning halted.");
        window.setTimeout(() => {
          setMachineStatus("OFF", "idle");
          appendTerminalLine("[SYSTEM] Auto mode stopped.");
        }, 900);
      }

      function confirmCloseApplication() {
        if (window.confirm("Close PCB AI? Conveyor motion will stop and the app window will close.")) {
          closeApplication();
        }
      }

      function handleGlobalKeyboardShortcuts(event) {
        if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "q") {
          event.preventDefault();
          confirmCloseApplication();
        }
      }

      async function closeApplication() {
        appendTerminalLine("[SYSTEM] Closing app.");
        stopMachine();
        try {
          await allConveyorRelaysOff({ writeLog: false });
        } catch (error) {
          appendTerminalLine(`[CONVEYOR ERROR] close relay shutdown failed: ${error.message}`);
        }

        try {
          const response = await fetch("/api/close-app", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `HTTP ${response.status}`);
          }
        } catch (error) {
          appendTerminalLine(`[SYSTEM ERROR] close request failed: ${error.message}`);
          window.close();
        }
      }

      function appendTerminalLine(line) {
        const terminal = document.getElementById("terminal-log");
        if (!terminalLines) {
          terminalLines = terminal.textContent.trim().split("\n").filter(Boolean);
        }

        terminalLines.push(line);
        if (terminalLines.length > MAX_TERMINAL_LINES) {
          terminalLines = terminalLines.slice(terminalLines.length - MAX_TERMINAL_LINES);
        }

        terminal.textContent = terminalLines.join("\n");
        terminal.scrollTop = terminal.scrollHeight;
      }

      function setRelayButtonVisual(channel, isOn, pending = false) {
        const button = document.getElementById(`relay-toggle-${channel}`);
        if (!button) {
          return;
        }

        relayStates[channel] = Boolean(isOn);
        button.textContent = isOn ? "On" : "Off";
        button.classList.toggle("relay-on", isOn);
        button.classList.toggle("relay-off", !isOn);
        button.classList.toggle("pending", pending);
        button.setAttribute("aria-busy", pending ? "true" : "false");
      }

      function updateConveyorRelayButtons(states = relayStates, options = {}) {
        const force = Boolean(options.force);
        for (const channel of CONVEYOR_RELAY_CHANNELS) {
          if (!force && Object.prototype.hasOwnProperty.call(relayPendingStates, channel)) {
            continue;
          }

          const isOn = Boolean(states[channel] || states[String(channel)]);
          setRelayButtonVisual(channel, isOn, false);
        }
      }

      function updateConveyorSensorIndicators(sensors = {}, rawLevels = {}) {
        for (const sensor of CONVEYOR_SENSOR_CHANNELS) {
          const indicator = document.getElementById(`sensor-status-${sensor}`);
          if (!indicator) {
            continue;
          }

          const detected = sensorIsDetected(sensors, sensor);
          const rawLevel = rawLevels[sensor] || rawLevels[String(sensor)] || "--";
          indicator.textContent = `${detected ? "Detected" : "Clear"} ${rawLevel}`;
          indicator.classList.toggle("active", detected);
        }
      }

      function sensorIsDetected(sensors = {}, sensor) {
        return Boolean(sensors[sensor] || sensors[String(sensor)]);
      }

      function updateConveyorIoStatus(payload) {
        updateConveyorRelayButtons(payload.states || {});
        updateConveyorSensorIndicators(payload.sensors || {}, payload.sensor_raw_levels || {});
        if (payload.sensor_errors) {
          for (const [sensor, message] of Object.entries(payload.sensor_errors)) {
            const warningKey = `${sensor}:${message}`;
            if (!conveyorIoWarningCache.has(warningKey)) {
              conveyorIoWarningCache.add(warningKey);
              appendTerminalLine(`[CONVEYOR WARNING] ${CONVEYOR_SENSOR_NAMES[sensor] || `Sensor ${sensor}`}: ${message}`);
            }
          }
        }
      }

      async function toggleConveyorRelay(channel) {
        const pendingState = relayPendingStates[channel];
        const currentState = Object.prototype.hasOwnProperty.call(relayPendingStates, channel)
          ? pendingState
          : relayStates[channel];
        await setConveyorRelay(channel, !currentState);
      }

      function updateSensorTransferButton() {
        const button = document.getElementById("sensor-transfer-toggle");
        if (!button) {
          return;
        }

        button.textContent = sensorTransferEnabled ? "Moving..." : "Move To Next Sensor";
        button.classList.toggle("relay-on", sensorTransferEnabled);
        button.classList.toggle("relay-off", !sensorTransferEnabled);
      }

      async function toggleSensorTransfer() {
        if (sensorTransferEnabled) {
          await stopSensorTransfer("manual stop");
          return;
        }

        const payload = await readConveyorIoStatusForTransfer();
        if (!payload) {
          return;
        }

        const startDetected = sensorIsDetected(payload.sensors, CONVEYOR_START_SENSOR_CHANNEL);
        const endDetected = sensorIsDetected(payload.sensors, CONVEYOR_END_SENSOR_CHANNEL);

        if (startDetected && endDetected) {
          appendTerminalLine("[SENSOR MOVE] both sensors are detected. Clear one sensor before starting.");
          return;
        }

        if (!startDetected && !endDetected) {
          appendTerminalLine("[SENSOR MOVE] no sensor is detected. Place a board at Start or End first.");
          return;
        }

        if (startDetected) {
          sensorTransferDirection = "forward";
          sensorTransferTarget = "end";
        } else {
          sensorTransferDirection = "reverse";
          sensorTransferTarget = "start";
        }

        sensorTransferEnabled = true;
        updateSensorTransferButton();
        appendTerminalLine(`[SENSOR MOVE] moving ${sensorTransferDirection} until ${sensorTransferTarget} sensor detects.`);
        await allConveyorRelaysOff({ keepSensorTransferState: true, writeLog: false });
        await setConveyorRelay(sensorTransferDirection === "forward" ? 1 : 2, true);

        sensorTransferTimer = window.setInterval(() => {
          runSensorTransferStep();
        }, 150);
        runSensorTransferStep();
      }

      async function stopSensorTransfer(reason = "complete") {
        sensorTransferEnabled = false;
        sensorTransferDirection = "stopped";
        sensorTransferTarget = null;
        if (sensorTransferTimer) {
          window.clearInterval(sensorTransferTimer);
          sensorTransferTimer = null;
        }
        updateSensorTransferButton();
        await allConveyorRelaysOff({ keepSensorTransferState: true, writeLog: false });
        appendTerminalLine(`[SENSOR MOVE] stopped: ${reason}.`);
      }

      async function readConveyorIoStatusForTransfer() {
        try {
          const response = await fetchWithTimeout(
            "/api/conveyor-relay-status",
            {},
            CONVEYOR_IO_REQUEST_TIMEOUT_MS
          );
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || `HTTP ${response.status}`);
          }

          updateConveyorIoStatus(payload);
          return payload;
        } catch (error) {
          appendTerminalLine(`[SENSOR MOVE ERROR] status failed: ${error.message}`);
          return null;
        }
      }

      async function runSensorTransferStep() {
        if (!sensorTransferEnabled || sensorTransferBusy) {
          return;
        }

        sensorTransferBusy = true;
        try {
          const payload = await readConveyorIoStatusForTransfer();
          if (!payload) {
            await stopSensorTransfer("sensor status failed");
            return;
          }

          const startDetected = sensorIsDetected(payload.sensors, CONVEYOR_START_SENSOR_CHANNEL);
          const endDetected = sensorIsDetected(payload.sensors, CONVEYOR_END_SENSOR_CHANNEL);

          if (sensorTransferTarget === "end" && endDetected) {
            await stopSensorTransfer("end sensor reached");
            return;
          }

          if (sensorTransferTarget === "start" && startDetected) {
            await stopSensorTransfer("start sensor reached");
          }
        } catch (error) {
          appendTerminalLine(`[SENSOR MOVE ERROR] ${error.message}`);
          await stopSensorTransfer("error");
        } finally {
          sensorTransferBusy = false;
        }
      }

      async function refreshConveyorIoStatus(writeLog = true) {
        if (conveyorIoPollBusy) {
          return;
        }

        conveyorIoPollBusy = true;
        try {
          const response = await fetchWithTimeout(
            "/api/conveyor-relay-status",
            {},
            CONVEYOR_IO_REQUEST_TIMEOUT_MS
          );
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || `HTTP ${response.status}`);
          }

          updateConveyorIoStatus(payload);
          if (writeLog) {
            const sensorSummary = CONVEYOR_SENSOR_CHANNELS.map((sensor) => (
              `${CONVEYOR_SENSOR_NAMES[sensor]}=${payload.sensors[sensor] ? "detected" : "clear"}`
            )).join(" ");
            appendTerminalLine(`[CONVEYOR] sensors ${sensorSummary}`);
          }
        } catch (error) {
          if (writeLog) {
            appendTerminalLine(`[CONVEYOR ERROR] status failed: ${error.message}`);
          }
        } finally {
          conveyorIoPollBusy = false;
        }
      }

      async function setConveyorRelay(channel, state) {
        const requestId = relayRequestIds[channel] + 1;
        relayRequestIds[channel] = requestId;
        const previousStates = { ...relayStates };
        relayPendingStates[channel] = Boolean(state);
        if (state && channel === 1) {
          relayRequestIds[2] += 1;
          relayPendingStates[2] = false;
          setRelayButtonVisual(2, false, true);
        }
        if (state && channel === 2) {
          relayRequestIds[1] += 1;
          relayPendingStates[1] = false;
          setRelayButtonVisual(1, false, true);
        }
        setRelayButtonVisual(channel, state, true);

        try {
          const response = await fetchWithTimeout("/api/conveyor-relay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel, state })
          }, CONVEYOR_IO_REQUEST_TIMEOUT_MS);
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || `HTTP ${response.status}`);
          }

          if (relayRequestIds[channel] !== requestId) {
            return;
          }

          relayPendingStates = {};
          updateConveyorRelayButtons(payload.states || {}, { force: true });
          updateConveyorSensorIndicators(payload.sensors || {}, payload.sensor_raw_levels || {});
          appendTerminalLine(`[CONVEYOR] ${channel === 1 ? "Forward" : "Reverse"} pin ${payload.relay_pins[channel]} ${state ? "ON" : "OFF"}.`);
          if (state && channel === 1 && previousStates[2] && !relayStates[2]) {
            appendTerminalLine("[SAFETY] Reverse relay forced OFF before Forward relay turned ON.");
          }
          if (state && channel === 2 && previousStates[1] && !relayStates[1]) {
            appendTerminalLine("[SAFETY] Forward relay forced OFF before Reverse relay turned ON.");
          }
        } catch (error) {
          if (relayRequestIds[channel] === requestId) {
            delete relayPendingStates[channel];
            if (channel === 1) {
              delete relayPendingStates[2];
            }
            if (channel === 2) {
              delete relayPendingStates[1];
            }
            updateConveyorRelayButtons(previousStates, { force: true });
          }
          appendTerminalLine(`[CONVEYOR ERROR] CH${channel}: ${error.message}`);
        }
      }

      async function allConveyorRelaysOff(options = {}) {
        const keepSensorTransferState = Boolean(options.keepSensorTransferState);
        const writeLog = options.writeLog !== false;
        if (!keepSensorTransferState && sensorTransferEnabled) {
          sensorTransferEnabled = false;
          sensorTransferDirection = "stopped";
          sensorTransferTarget = null;
          if (sensorTransferTimer) {
            window.clearInterval(sensorTransferTimer);
            sensorTransferTimer = null;
          }
          updateSensorTransferButton();
        }

        const previousStates = { ...relayStates };
        for (const channel of CONVEYOR_RELAY_CHANNELS) {
          relayRequestIds[channel] += 1;
          relayPendingStates[channel] = false;
          setRelayButtonVisual(channel, false, true);
        }

        try {
          const response = await fetchWithTimeout("/api/conveyor-relay-all-off", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          }, CONVEYOR_IO_REQUEST_TIMEOUT_MS);
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || `HTTP ${response.status}`);
          }

          relayPendingStates = {};
          updateConveyorRelayButtons(payload.states || {}, { force: true });
          updateConveyorSensorIndicators(payload.sensors || {}, payload.sensor_raw_levels || {});
          if (writeLog) {
            appendTerminalLine("[CONVEYOR] All relay channels OFF.");
          }
        } catch (error) {
          relayPendingStates = {};
          updateConveyorRelayButtons(previousStates, { force: true });
          appendTerminalLine(`[CONVEYOR ERROR] all off failed: ${error.message}`);
        }
      }

      async function stopExistingPreview(video) {
        // Explicitly stop old tracks before reconnecting so Chromium does not
        // keep the USB inspection camera locked after a UI refresh.
        if (!video.srcObject) {
          return;
        }

        for (const track of video.srcObject.getTracks()) {
          track.stop();
        }
        video.srcObject = null;
      }

      async function connectAxis() {
        try {
          const response = await fetch(`${AXIS_BRIDGE_URL}/axis/status`);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const payload = await response.json();
          axisBridgeConnected = true;
          const position = updateAxisPositionFromStatus(payload.status);
          appendTerminalLine(
            `[AXIS] Bridge connected. ${formatAxisPositionForLog(payload.status, position)}`
          );
        } catch (error) {
          axisBridgeConnected = false;
          appendTerminalLine(
            `[ERROR] Axis bridge unavailable. Check Jetson service: sudo systemctl status pcb-axis-bridge.service`
          );
        }
      }

      async function ensureAxisConnectedForStart() {
        if (axisBridgeConnected) {
          return true;
        }

        await connectAxis();
        return axisBridgeConnected;
      }

      async function ensureCameraConnectedForStart() {
        if (!cameraConnected) {
          await openPreviewCamera();
        }

        const video = document.getElementById("webcam-preview");
        await waitForVideoReady(video, CAMERA_READY_TIMEOUT_MS);
        if (!video.srcObject || !video.videoWidth || !video.videoHeight) {
          cameraConnected = false;
          return false;
        }

        const tracks = video.srcObject.getVideoTracks();
        if (tracks.length === 0) {
          cameraConnected = false;
          return false;
        }

        const liveTrack = tracks.find((track) => track.readyState === "live" && !track.muted);
        if (!liveTrack) {
          cameraConnected = false;
          return false;
        }

        cameraConnected = true;
        return true;
      }

      async function autoConnectAxis() {
        await connectAxis();
      }

      async function postAxis(path, body = {}) {
        const response = await fetch(`${AXIS_BRIDGE_URL}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      }

      async function testAxisMove() {
        if (!axisBridgeConnected) {
          await connectAxis();
        }

        if (!axisBridgeConnected) {
          return;
        }

        try {
          const payload = await postAxis("/axis/test");
          appendTerminalLine(`[AXIS] Test complete. ${JSON.stringify(payload.responses)}`);
        } catch (error) {
          axisBridgeConnected = false;
          appendTerminalLine(`[ERROR] Axis test failed: ${error.message}`);
        }
      }

      async function stopAxis() {
        if (!axisBridgeConnected) {
          return;
        }

        try {
          const payload = await postAxis("/axis/stop");
          appendTerminalLine(`[AXIS] stop requested. ${payload.status || ""}`);
        } catch (error) {
          appendTerminalLine(`[ERROR] Axis stop failed: ${error.message}`);
        }
      }

      async function setAxisZero() {
        if (!axisBridgeConnected) {
          await connectAxis();
        }

        if (!axisBridgeConnected) {
          return false;
        }

        try {
          const payload = await postAxis("/axis/set-zero");
          searchStartXmm = 0;
          searchStartYmm = 0;
          searchXmm = 0;
          searchYmm = 0;
          searchPattern = buildFullAreaSearchPattern();
          resetSearchState();
          appendTerminalLine("[AXIS] Set current position to X0 Y0.");
          const afterStatus = payload.lines.find((line) => line.startsWith("after="));
          const position = afterStatus ? parseMachinePosition(afterStatus) : { x: 0, y: 0, z: 0 };
          appendTerminalLine(
            `[AXIS] Work position now X=${position.x.toFixed(3)} Y=${position.y.toFixed(3)}. Raw status: ${payload.lines.join(" | ")}`
          );
          return true;
        } catch (error) {
          appendTerminalLine(`[ERROR] Set zero failed: ${error.message}`);
          return false;
        }
      }

      function wait(milliseconds) {
        return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
      }

      function cameraLooksLikeElp(device) {
        // Browser device labels are only available after the page has camera
        // permission. Prefer the inspection camera by its known names first.
        const label = device.label.toLowerCase();
        return (
          label.includes("elp") ||
          label.includes("48mp") ||
          label.includes("48 mp") ||
          label.includes("32e4:4802")
        );
      }

      function cameraLooksInternal(device) {
        const label = device.label.toLowerCase();
        return (
          label.includes("integrated") ||
          label.includes("built-in") ||
          label.includes("facetime") ||
          label.includes("laptop") ||
          label.includes("webcam")
        );
      }

      function cameraLooksExternalUsb(device) {
        const label = device.label.toLowerCase();
        return (
          !cameraLooksInternal(device) &&
          (
            label.includes("usb") ||
            label.includes("uvc") ||
            label.includes("camera")
          )
        );
      }

      async function getVideoInputDevices() {
        // First ask for temporary access. Without this, Chrome/Edge hide camera
        // names and every device label comes back blank.
        const permissionStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false
        });

        for (const track of permissionStream.getTracks()) {
          track.stop();
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((device) => device.kind === "videoinput");
      }

      function getPreferredCameraDevices(videoDevices) {
        const savedDeviceId = window.localStorage.getItem(CAMERA_DEVICE_STORAGE_KEY);
        const orderedDevices = [];
        const addDevice = (device) => {
          if (device && !orderedDevices.some((candidate) => candidate.deviceId === device.deviceId)) {
            orderedDevices.push(device);
          }
        };

        addDevice(videoDevices.find((device) => device.deviceId === savedDeviceId));
        addDevice(videoDevices.find(cameraLooksLikeElp));
        videoDevices.filter(cameraLooksExternalUsb).forEach(addDevice);
        if (videoDevices.length === 1 && !cameraLooksInternal(videoDevices[0])) {
          addDevice(videoDevices[0]);
        }

        return orderedDevices;
      }

      async function openCameraStreamForDevice(device) {
        const highResolutionConstraints = {
          video: {
            deviceId: { exact: device.deviceId },
            width: { ideal: 8000 },
            height: { ideal: 6000 },
            frameRate: { ideal: 60 }
          },
          audio: false
        };
        const basicConstraints = {
          video: {
            deviceId: { exact: device.deviceId }
          },
          audio: false
        };

        try {
          return await navigator.mediaDevices.getUserMedia(highResolutionConstraints);
        } catch (error) {
          appendTerminalLine(`[CAMERA] High resolution open failed for ${device.label || "camera"}: ${error.name || error.message}. Retrying basic mode.`);
          return navigator.mediaDevices.getUserMedia(basicConstraints);
        }
      }

      function waitForVideoReady(video, timeoutMs = CAMERA_READY_TIMEOUT_MS) {
        if (video.videoWidth && video.videoHeight) {
          return Promise.resolve(true);
        }

        return new Promise((resolve) => {
          let settled = false;
          const finish = (ready) => {
            if (settled) {
              return;
            }
            settled = true;
            video.removeEventListener("loadedmetadata", handleReady);
            video.removeEventListener("canplay", handleReady);
            window.clearTimeout(timeout);
            resolve(ready);
          };
          const handleReady = () => finish(Boolean(video.videoWidth && video.videoHeight));
          const timeout = window.setTimeout(() => finish(Boolean(video.videoWidth && video.videoHeight)), timeoutMs);

          video.addEventListener("loadedmetadata", handleReady, { once: true });
          video.addEventListener("canplay", handleReady, { once: true });
        });
      }

      async function openPreviewCamera() {
        const video = document.getElementById("webcam-preview");
        const message = document.getElementById("camera-message");
        const meta = document.getElementById("camera-meta");

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          cameraConnected = false;
          message.textContent = "Browser camera access is unavailable";
          message.style.display = "grid";
          meta.textContent = "Camera not connected";
          return;
        }

        try {
          await stopExistingPreview(video);
          const videoDevices = await getVideoInputDevices();
          const preferredDevices = getPreferredCameraDevices(videoDevices);
          if (!preferredDevices.length) {
            cameraConnected = false;
            message.textContent = "No USB camera found";
            message.style.display = "grid";
            meta.textContent = "Camera not connected";
            appendTerminalLine("[CAMERA] No inspection camera candidate found.");
            return;
          }

          let stream = null;
          let selectedDevice = null;
          let lastError = null;
          for (const device of preferredDevices) {
            try {
              stream = await openCameraStreamForDevice(device);
              selectedDevice = device;
              break;
            } catch (error) {
              lastError = error;
              appendTerminalLine(`[CAMERA] Could not open ${device.label || "camera"}: ${error.name || error.message}.`);
            }
          }

          if (!stream) {
            throw lastError || new Error("No camera stream opened.");
          }

          video.srcObject = stream;
          await waitForVideoReady(video, CAMERA_READY_TIMEOUT_MS);

          const [track] = stream.getVideoTracks();
          track.addEventListener("ended", () => {
            cameraConnected = false;
            setMachineStatus("CAMERA NOT CONNECTED", "error");
            meta.textContent = "Camera not connected";
            message.textContent = "Camera disconnected";
            message.style.display = "grid";
            appendTerminalLine("[ERROR] Camera stream ended.");
          });
          track.addEventListener("mute", () => {
            cameraConnected = false;
            meta.textContent = "Camera signal unavailable";
            message.textContent = "Camera signal unavailable";
            message.style.display = "grid";
            appendTerminalLine("[ERROR] Camera signal muted or unavailable.");
          });
          track.addEventListener("unmute", () => {
            cameraConnected = true;
            message.style.display = "none";
          });
          const settings = track.getSettings();
          const label = track.label || "ELP USB Camera";
          const width = settings.width || "?";
          const height = settings.height || "?";
          meta.textContent = `${label} | ${width} x ${height}`;
          if (selectedDevice && selectedDevice.deviceId) {
            window.localStorage.setItem(CAMERA_DEVICE_STORAGE_KEY, selectedDevice.deviceId);
          }
          cameraConnected = true;
          message.style.display = "none";
          appendTerminalLine(`[CAMERA] Connected ${label} at ${width} x ${height}.`);
        } catch (error) {
          cameraConnected = false;
          message.textContent = "Camera blocked or unavailable. Allow camera access and close other camera apps.";
          message.style.display = "grid";
          meta.textContent = "Camera not connected";
          appendTerminalLine(`[CAMERA ERROR] ${error.name || "Camera"}: ${error.message || error}`);
        }
      }

