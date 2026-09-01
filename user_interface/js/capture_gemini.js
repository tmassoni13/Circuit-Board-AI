function timestampForFilename() {
        return new Date().toISOString().replace(/[:.]/g, "-");
      }

      async function captureStillBlob() {
        const video = document.getElementById("webcam-preview");
        const message = document.getElementById("camera-message");

        if (!video.srcObject) {
          message.style.display = "grid";
          message.textContent = "Camera is not open";
          return null;
        }

        const [track] = video.srcObject.getVideoTracks();

        // `ImageCapture.takePhoto()` can access true still-image modes on some
        // UVC cameras. This is the best browser-side chance of getting the
        // ELP camera's full still resolution instead of only the video stream.
        if ("ImageCapture" in window) {
          try {
            const imageCapture = new ImageCapture(track);
            const capabilities = await imageCapture.getPhotoCapabilities();
            const photoSettings = {};

            if (capabilities.imageWidth) {
              photoSettings.imageWidth = capabilities.imageWidth.max;
            }

            if (capabilities.imageHeight) {
              photoSettings.imageHeight = capabilities.imageHeight.max;
            }

            const blob = await imageCapture.takePhoto(photoSettings);
            return blob;
          } catch (error) {
            // Fall through to canvas capture when the browser or camera driver
            // rejects still-photo mode.
          }
        }

        // Fallback: save the current video frame. This will only be as large as
        // the active browser video stream, not necessarily the full 48 MP sensor.
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return new Promise((resolve) => {
          canvas.toBlob((blob) => resolve(blob), "image/jpeg", 1.0);
        });
      }

      async function captureStillImage() {
        const blob = await captureStillBlob();
        if (!blob) {
          return;
        }

        const imageName = nextCaptureName();
        addImageToLog(blob, imageName, DEFAULT_IMAGE_FOLDER_NAME);
        appendTerminalLine(`[CAPTURE] Image ${imageName} saved to ${DEFAULT_IMAGE_FOLDER_NAME}.`);
        await analyzeBoardImages(imageName, [{ name: imageName, blob }], "MANUAL");
      }

      async function analyzeBoardImages(boardNumber, capturedImages, source = "AUTO", promptContext = "", options = {}) {
        if (!capturedImages.length) {
          return null;
        }

        const updateStatus = options.updateStatus !== false;

        try {
          if (updateStatus) {
            setMachineStatus("ANALYZING", "searching");
          }
          const uploadQuality = GEMINI_UPLOAD_QUALITY_OPTIONS[readGeminiUploadQuality()];
          const uploadSize = Number.isFinite(uploadQuality.maxDimension)
            ? `${uploadQuality.maxDimension}px max side`
            : "full image";
          appendTerminalLine(
            `[GEMINI] analyzing board ${boardNumber} with ${capturedImages.length} image(s). upload=${uploadQuality.label} ${uploadSize}.`
          );

          const images = [];
          for (const image of capturedImages) {
            images.push(await blobToGeminiImage(image.blob, image.name));
          }
          appendTerminalLine(`[GEMINI] upload prepared. Sending request to Gemini.`);

          const response = await fetchWithTimeout("/api/analyze-board", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              board: String(boardNumber),
              source,
              prompt_context: promptContext,
              images
            })
          }, GEMINI_ANALYSIS_TIMEOUT_MS);

          const result = await response.json();
          if (!response.ok) {
            throw new Error(result.error || `HTTP ${response.status}`);
          }

          await recordInspectionResult(boardNumber, result, capturedImages, { updateStatus });
          return result;
        } catch (error) {
          appendTerminalLine(`[GEMINI ERROR] board ${boardNumber}: ${error.message}`);
          if (updateStatus) {
            setMachineStatus("AI ERROR", "error");
          }
          return null;
        }
      }

      async function blobToGeminiImage(blob, imageName) {
        const resizedBlob = await resizeImageBlobForAnalysis(blob);
        const dataUrl = await blobToDataUrl(resizedBlob);
        const commaIndex = dataUrl.indexOf(",");
        const data = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
        appendTerminalLine(
          `[GEMINI] ${imageName} original=${formatBytes(blob.size)} prepared=${formatBytes(resizedBlob.size)} payload=${formatBytes(data.length)}.`
        );
        return {
          name: imageName,
          mime_type: resizedBlob.type || "image/jpeg",
          data
        };
      }

      function resizeImageBlobForAnalysis(blob) {
        const quality = readGeminiUploadQuality();
        const option = GEMINI_UPLOAD_QUALITY_OPTIONS[quality];
        const maxDimension = option.maxDimension;

        if (!Number.isFinite(maxDimension)) {
          return Promise.resolve(blob);
        }

        return new Promise((resolve, reject) => {
          const image = new Image();
          const objectUrl = URL.createObjectURL(blob);

          image.onload = () => {
            const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
            const scale = largestSide > maxDimension
              ? maxDimension / largestSide
              : 1;
            const width = Math.max(1, Math.round(image.naturalWidth * scale));
            const height = Math.max(1, Math.round(image.naturalHeight * scale));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0, width, height);
            URL.revokeObjectURL(objectUrl);
            canvas.toBlob(
              (resizedBlob) => {
                if (resizedBlob) {
                  resolve(resizedBlob);
                } else {
                  reject(new Error("Could not prepare image for Gemini."));
                }
              },
              "image/jpeg",
              option.jpegQuality
            );
          };

          image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error("Could not load captured image for Gemini."));
          };

          image.src = objectUrl;
        });
      }

      function fetchWithTimeout(url, options, timeoutMs) {
        if (typeof AbortController === "undefined") {
          return fetch(url, options);
        }

        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { ...options, signal: controller.signal })
          .finally(() => window.clearTimeout(timeout));
      }

      function formatBytes(bytes) {
        if (!Number.isFinite(bytes)) {
          return "?";
        }

        if (bytes >= 1024 * 1024) {
          return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
        }

        return `${Math.round(bytes / 1024)}KB`;
      }

      function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Could not read image data."));
          reader.readAsDataURL(blob);
        });
      }

