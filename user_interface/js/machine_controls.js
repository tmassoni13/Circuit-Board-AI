function setMachineStatus(value, state = "idle") {
        const status = document.querySelector(".status");
        const statusValue = document.querySelector(".status-value");
        statusValue.textContent = value;
        status.classList.toggle("running", state === "running");
        status.classList.toggle("searching", state === "searching");
        status.classList.toggle("error", state === "error");
      }

      function setMachineRunning(running) {
        machineRunning = running;
        setStartupControlMode("normal");
        const button = document.getElementById("machine-toggle");
        button.textContent = running ? "Stop" : "Start";
        button.classList.toggle("start", !running);
        button.classList.toggle("stop", running);
      }

      function setStartupControlMode(mode) {
        const normalButton = document.getElementById("machine-toggle");
        const retryButton = document.getElementById("startup-retry");
        const stopButton = document.getElementById("startup-stop");
        const failed = mode === "failure";

        normalButton.classList.toggle("hidden", failed);
        retryButton.classList.toggle("hidden", !failed);
        stopButton.classList.toggle("hidden", !failed);
      }

      function toggleMachine() {
        if (machineRunning) {
          stopMachine();
        } else {
          startMachine();
        }
      }

      function retryStartup() {
        setStartupControlMode("normal");
        startMachine();
      }

      function resetMachine() {
        stopAutoBoardScan();
        axisMoveInFlight = false;
        searchMoveInFlight = false;
        inspectionMode = "search";
        machineRunning = false;
        setStartupControlMode("normal");
        setMachineRunning(false);
        setMachineStatus("OFF", "idle");
        appendTerminalLine("[SYSTEM] Startup reset.");
      }

