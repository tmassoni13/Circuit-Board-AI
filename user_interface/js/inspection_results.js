async function recordInspectionResult(boardNumber, result, capturedImages = [], options = {}) {
        const defectCount = Array.isArray(result.fatal_defects)
          ? result.fatal_defects.length
          : 0;
        const passed = Boolean(result.passed) && defectCount === 0;
        const confidencePercent = Math.round((Number(result.confidence) || 0) * 100);
        const statusText = passed ? "PASS" : "FAIL";
        const summary = result.summary || (passed ? "No fatal defects" : "Fatal defect detected");

        markCapturedImages(capturedImages, passed ? "pass" : "fail", summary);
        if (options.updateStatus !== false) {
          setMachineStatus(passed ? "BOARD PASSED" : "BOARD FAILED", passed ? "running" : "error");
        }
        appendTerminalLine(
          `[GEMINI RESULT] board ${boardNumber} ${statusText} confidence=${confidencePercent}% fatal_defects=${defectCount} ${summary}`
        );

        if (defectCount > 0) {
          result.fatal_defects.slice(0, 5).forEach((defect, index) => {
            appendTerminalLine(
              `[DEFECT ${index + 1}] ${defect.type || "defect"} ${defect.location || ""} ${defect.reason || ""}`.trim()
            );
          });
        }

        if (!passed) {
          const failureDefects = defectCount > 0
            ? result.fatal_defects
            : [{
                image: capturedImages[0] ? capturedImages[0].name : "",
                type: "failed inspection",
                location: "image",
                reason: summary
              }];
          saveFailureImages(boardNumber, capturedImages, failureDefects);
        }
      }

      function markCapturedImages(capturedImages, inspectionStatus, description = "") {
        for (const image of capturedImages) {
          const entries = findImageEntriesByName(image.name);
          for (const entry of entries) {
            entry.inspectionStatus = inspectionStatus;
            entry.failureDescription = description;
            if (inspectionStatus === "pass") {
              removeFailureCopiesForImage(image.name, false);
            }
          }
        }

        renderImageLogView();
      }

      function findImageEntriesByName(imageName) {
        const matches = [];
        for (const folder of imageFolders) {
          for (const entry of folder.entries) {
            if (entry.name === imageName) {
              matches.push(entry);
            }
          }
        }

        return matches;
      }

      function saveFailureImages(boardNumber, capturedImages, fatalDefects) {
        const failureFolder = ensureImageFolder(FAILURE_IMAGE_FOLDER_NAME);
        const defectsByImage = groupDefectsByImage(capturedImages, fatalDefects);

        for (const image of capturedImages) {
          const defects = defectsByImage[image.name] || [];
          if (!defects.length) {
            continue;
          }

          const failureName = `${image.name}-failure`;
          removeFailureCopiesForImage(image.name, false);
          const entry = addImageToLog(image.blob, failureName, failureFolder.name);
          entry.inspectionStatus = "fail";
          entry.failureDescription = failureDescriptionForImage(defects);

          const originalEntries = findImageEntriesByName(image.name);
          for (const originalEntry of originalEntries) {
            originalEntry.inspectionStatus = "fail";
            originalEntry.failureDescription = entry.failureDescription;
          }

          appendTerminalLine(`[FAILURE IMAGE] saved ${failureFolder.name}/${failureName}: ${entry.failureDescription}`);
        }

        renderImageLogView();
      }

      function removeFailureCopiesForImage(imageName, logRemoval = true) {
        const failureFolder = getImageFolder(FAILURE_IMAGE_FOLDER_NAME);
        const failureName = `${imageName}-failure`;
        let removedCount = 0;

        for (let index = failureFolder.entries.length - 1; index >= 0; index -= 1) {
          const entry = failureFolder.entries[index];
          if (entry.name !== failureName) {
            continue;
          }

          failureFolder.entries.splice(index, 1);
          URL.revokeObjectURL(entry.url);
          removedCount += 1;
        }

        if (removedCount > 0 && logRemoval) {
          appendTerminalLine(`[IMAGE LOG] Removed ${removedCount} linked failure image(s) for ${imageName}.`);
        }
      }

      function groupDefectsByImage(capturedImages, fatalDefects) {
        const imageNames = capturedImages.map((image) => String(image.name));
        const groups = {};
        for (const imageName of imageNames) {
          groups[imageName] = [];
        }

        fatalDefects.forEach((defect) => {
          const defectImage = String(defect.image || "").trim();
          const matchedName = imageNames.find((name) => name === defectImage) ||
            imageNames.find((name) => defectImage.includes(name)) ||
            imageNames[0];
          if (matchedName) {
            groups[matchedName].push(defect);
          }
        });

        return groups;
      }

      function failureDescriptionForImage(defects) {
        return defects.slice(0, 3).map((defect, index) => {
          const type = defect.type || "fatal defect";
          const location = defect.location ? ` at ${defect.location}` : "";
          const reason = defect.reason ? `: ${defect.reason}` : "";
          return `${index + 1}. ${type}${location}${reason}`;
        }).join(" | ");
      }

      function updateInspectionCounters() {
        let passedImages = 0;
        let failedImages = 0;
        const folder = getImageFolder(autoCaptureFolderName);

        if (folder.name !== FAILURE_IMAGE_FOLDER_NAME) {
          for (const entry of folder.entries) {
            if (entry.inspectionStatus === "pass") {
              passedImages += 1;
            } else if (entry.inspectionStatus === "fail") {
              failedImages += 1;
            }
          }
        }

        document.getElementById("passed-count").textContent = String(passedImages);
        document.getElementById("failed-count").textContent = String(failedImages);
      }

