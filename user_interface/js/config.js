const AUTO_SCAN_INTERVAL_MS = 250;
      const BOARD_MIN_CONFIDENCE = 0.75;
      const BOARD_BOX_WIDTH_RATIO = 0.62;
      const BOARD_BOX_HEIGHT_RATIO = 0.82;
      const BOARD_STABLE_FRAME_COUNT = 5;
      const BOARD_LEAVE_FRAME_COUNT = 8;
      const BOARD_PRESENCE_PIXEL_RATIO = 0.002;
      const BOARD_PRESENCE_FRAME_COUNT = 4;
      const BOARD_CANDIDATE_OVERLAP = 0.35;
      const CAPTURE_BOTTOM_MARGIN_RATIO = 0.04;
      const CAPTURE_CORNER_ALIGN_MAX_STEPS = 8;
      const CAPTURE_CORNER_ALIGN_DEADBAND = 0.012;
      const CAPTURE_CORNER_FEED_MM_MIN = 3000;
      const CAPTURE_CORNER_MIN_STEP_MM = 8;
      const CAPTURE_CORNER_MAX_STEP_MM = 30;
      const CAPTURE_CORNER_MM_PER_OFFSET = 160;
      const CAPTURE_CORNER_SETTLE_MS = 500;
      const CAPTURE_CORNER_EDGE_WAIT_FRAMES = 20;
      const CAPTURE_CORNER_EDGE_WAIT_MS = 100;
      const CAPTURE_EDGE_ALIGNMENT_TOLERANCE_MM = 20;
      const CAPTURE_EDGE_NO_EDGE_SEARCH_MM = 25;
      const CAPTURE_EDGE_MAX_SEARCH_MOVES = 4;
      const CAPTURE_EDGE_AUTO_CORRECT_MAX_MM = 120;
      const AXIS_RELATIVE_SIGN_X = -1;
      const AXIS_RELATIVE_SIGN_Y = 1;
      const CAPTURE_BOTTOM_SIGN_Y = 1;
      const CAPTURE_RIGHT_SIGN_X = 1;
      const AXIS_AUTO_ALIGN_ENABLED = true;
      const AXIS_BRIDGE_URL = "http://127.0.0.1:8765";
      const AXIS_FEED_MM_MIN = 6000;
      const AXIS_MIN_FEED_MM_MIN = 1800;
      const AXIS_ALIGN_DEADBAND = 0.025;
      const AXIS_CORRECTION_MM_PER_OFFSET = 110;
      const AXIS_MIN_STEP_MM = 1.5;
      const AXIS_MAX_STEP_MM = 30;
      const AXIS_MOVE_COOLDOWN_MS = 60;
      const AXIS_NEAR_ALIGN_COOLDOWN_MS = 350;
      const AXIS_MIN_GREEN_PIXEL_RATIO = 0.01;
      const AXIS_SMOOTHING = 0.72;
      const AXIS_STOP_ALIGNMENT = 0.88;
      const AXIS_SIGN_X = 1;
      const AXIS_SIGN_Y = 1;
      const SEARCH_MOVE_MM = 50;
      const DEFAULT_BOARD_WIDTH_MM = 100;
      const DEFAULT_BOARD_HEIGHT_MM = 100;
      const DEFAULT_BOARD_BACKGROUND_COLOR = "#002d04";
      const DEFAULT_CAMERA_FOV_WIDTH_MM = 150;
      const DEFAULT_CAMERA_FOV_HEIGHT_MM = 150;
      const CAPTURE_OVERLAP_MM = 15;
      const CAPTURE_PRE_IMAGE_SETTLE_MS = 1000;
      const CAPTURE_SECOND_IMAGE_PRE_SETTLE_MS = 2000;
      const CAPTURE_POST_IMAGE_SETTLE_MS = 1000;
      const DEFAULT_GEMINI_UPLOAD_QUALITY = "full";
      const GEMINI_UPLOAD_QUALITY_OPTIONS = {
        full: {
          label: "Full",
          maxDimension: Infinity,
          jpegQuality: 0.98
        },
        fast: {
          label: "Fast",
          maxDimension: 2400,
          jpegQuality: 0.9
        },
        "ultra-fast": {
          label: "Ultra Fast",
          maxDimension: 1200,
          jpegQuality: 0.78
        }
      };
      const GEMINI_ANALYSIS_TIMEOUT_MS = 120000;
      const CAPTURE_SCAN_SIGN_X = 1;
      const CAPTURE_SCAN_SIGN_Y = 1;
      const AXIS_ABSOLUTE_MIN_X_MM = -180;
      const AXIS_ABSOLUTE_MAX_X_MM = 180;
      const AXIS_ABSOLUTE_MIN_Y_MM = -175;
      const AXIS_ABSOLUTE_MAX_Y_MM = 175;
      const SEARCH_FEED_MM_MIN = 2500;
      const SEARCH_COOLDOWN_MS = 1400;
      const SEARCH_FAST_MOVE_MM = 100;
      const SEARCH_OBVIOUS_ALIGNMENT = 0.60;
      const SEARCH_OBVIOUS_GREEN_PIXEL_RATIO = 0.015;
      const DEFAULT_IMAGE_FOLDER_NAME = "Manual Captures";
      const FAILURE_IMAGE_FOLDER_NAME = "failures";
      const PROTECTED_IMAGE_FOLDERS = [DEFAULT_IMAGE_FOLDER_NAME, FAILURE_IMAGE_FOLDER_NAME];
      const CONVEYOR_RELAY_CHANNELS = [1, 2];
      const CONVEYOR_START_SENSOR_CHANNEL = 1;
      const CONVEYOR_CAMERA_SENSOR_CHANNEL = 2;
      const CONVEYOR_END_SENSOR_CHANNEL = 3;
      const CONVEYOR_SENSOR_CHANNELS = [
        CONVEYOR_START_SENSOR_CHANNEL,
        CONVEYOR_CAMERA_SENSOR_CHANNEL,
        CONVEYOR_END_SENSOR_CHANNEL
      ];
      const CONVEYOR_SENSOR_NAMES = {
        1: "Start",
        2: "Camera",
        3: "End"
      };
      const CONVEYOR_IO_POLL_INTERVAL_MS = 500;
      const CONVEYOR_IO_REQUEST_TIMEOUT_MS = 3000;
      const MAX_TERMINAL_LINES = 260;
      const CAMERA_DEVICE_STORAGE_KEY = "pcbInspectorCameraDeviceId";
      const CAMERA_READY_TIMEOUT_MS = 2500;
      const AXIS_BRIDGE_REQUEST_TIMEOUT_MS = 2500;
      const AUTO_CONVEYOR_POLL_INTERVAL_MS = 75;
      const CONVEYOR_MOVE_TO_CAMERA_TIMEOUT_MS = 20000;
      const CAMERA_SENSOR_SETTLE_MS = 1000;

      let autoScanTimer = null;
      let stableBoardFrames = 0;
      let missingBoardFrames = 0;
      let lastBoardBox = null;
      let capturedCurrentBoard = false;
      let lastAxisHoldLogTime = 0;
      let axisBridgeConnected = false;
      let axisMoveInFlight = false;
      let lastAxisMoveTime = 0;
      let currentAxisMoveCooldownMs = AXIS_MOVE_COOLDOWN_MS;
      let smoothedAxisOffsetX = 0;
      let smoothedAxisOffsetY = 0;
      let searchIndex = 0;
      let searchStartXmm = null;
      let searchStartYmm = null;
      let searchXmm = null;
      let searchYmm = null;
      let lastSearchMoveTime = 0;
      let searchMoveInFlight = false;
      let searchPattern = [];
      let inspectionMode = "search";
      let cameraConnected = false;
      let machineRunning = false;
      let imageFolders = [
        {
          name: DEFAULT_IMAGE_FOLDER_NAME,
          entries: [],
          promptNote: ""
        },
        {
          name: FAILURE_IMAGE_FOLDER_NAME,
          entries: [],
          promptNote: ""
        }
      ];
      let activeImageFolderName = DEFAULT_IMAGE_FOLDER_NAME;
      let autoCaptureFolderName = DEFAULT_IMAGE_FOLDER_NAME;
      let imageLogView = "folders";
      let activeFolderPromptEditorName = null;
      let nextBoardNumber = 1;
      let nextImageNumberForBoard = 1;
      let boardPresenceFrames = 0;
      let boardInRange = false;
      let pendingBoardBox = null;
      let boardWorkflowInProgress = false;
      let waitingForNextBoard = false;
      let relayStates = {
        1: false,
        2: false
      };
      let conveyorIoPollTimer = null;
      let conveyorIoPollBusy = false;
      let sensorTransferTimer = null;
      let sensorTransferEnabled = false;
      let sensorTransferDirection = "stopped";
      let sensorTransferTarget = null;
      let sensorTransferBusy = false;
      let terminalLines = null;
      let relayRequestIds = {
        1: 0,
        2: 0
      };
      let relayPendingStates = {};
      let conveyorIoWarningCache = new Set();
      let autoConveyorState = "idle";
      let autoConveyorBusy = false;
      let autoConveyorMoveDirection = "stopped";
      let ignoreEndSensorUntilNextBoard = false;
      let lastCaptureFailureReason = "";
      let captureCancelToken = 0;
      let lastCaptureCancelLogToken = null;

