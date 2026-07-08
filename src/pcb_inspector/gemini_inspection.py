import json
import os
import re
from typing import Dict, List
from urllib import request
from urllib.error import HTTPError, URLError


DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"


INSPECTION_PROMPT = """
You are inspecting images from an inline AOI station for assembled PCB boards.

This is not a bare-board quality check. The board is expected to be populated
with all required components. A board that only has copper pads, solder pads,
silkscreen outlines, or empty component footprints is a failed assembly even if
the PCB substrate itself looks clean.

Analyze all provided images as one board inspection. Look for fatal production
defects such as:
- missing components on visible footprints or pads
- a mostly bare or completely bare PCB where components should be installed
- tombstoned parts
- shifted, skewed, or misplaced parts
- wrong polarity/orientation
- bridged solder
- insufficient solder
- lifted leads
- damaged pads
- damaged traces
- contamination
- obvious physical damage

Soldering defects are a major inspection priority. Carefully check visible pads,
joints, leads, pins, and terminals for bridges, opens, cold joints, poor wetting,
excess solder, insufficient solder, lifted leads, solder balls, solder splatter,
or any connection that looks mechanically or electrically unreliable.

Some boards may include manual work, hand soldering, rework, bodge wires,
jumpers, or other non-automated assembly corrections. Do not fail a board only
because work appears manual. Instead, verify that the manual work appears
intentional, electrically connected where needed, mechanically secure, not
shorting nearby pads/traces, not damaging components, and likely to allow the
board to operate correctly. Fail manual work only when it looks incorrect,
unreliable, unsafe, incomplete, or likely to break board function.

Do not automatically fail a board only because some pads or footprints are
empty. Some pads, optional footprints, test pads, jumpers, programming headers,
configuration positions, and alternate component locations may intentionally be
left unpopulated. Inspect every component that does exist and verify that those
installed parts and solder joints look correct. Fail empty pads/footprints only
when the image strongly suggests the component is required, the board is clearly
bare or mostly unpopulated, silkscreen/design context indicates a missing part,
or the missing population is likely to break board function. Do not return a
good verdict just because the bare PCB substrate is undamaged. A good verdict
means the visible installed components and solder joints appear functional and
there are no fatal defects.

Return only JSON with this shape:
{
  "verdict": "good" or "bad",
  "confidence": number from 0 to 1,
  "summary": "short operator-facing sentence",
  "fatal_defects": [
    {
      "image": "image name if known",
      "type": "short defect type",
      "location": "short location",
      "reason": "short reason"
    }
  ],
  "notes": ["short useful notes"]
}

For each fatal defect, clearly describe what is wrong and where it appears in
the image. The app stores failed images with this description for operator
review, so the reason must be specific enough to understand the failure without
guessing.

If the image is not clear enough to inspect, return verdict "bad" and explain
that the image quality is insufficient. If the board appears bare or mostly
unpopulated, return verdict "bad" with high confidence and list missing
components / unpopulated footprints as the fatal defect. If only a few pads or
optional-looking footprints are empty, do not call that fatal unless there is
clear evidence they should be populated.
"""


def analyze_pcb_images(images: List[Dict[str, str]], extra_context: str = "") -> Dict:
    """Send board images to Gemini and return a normalized inspection result.

    The browser sends already-downscaled JPEG images as base64 strings. The
    API key is read from `GEMINI_API_KEY` so secrets stay on the Jetson instead
    of being committed into the web UI.
    """
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set for the UI service.")

    if not images:
        raise ValueError("No images were provided for Gemini analysis.")

    model = os.environ.get("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + model
        + ":generateContent?key="
        + api_key
    )

    parts = [{"text": INSPECTION_PROMPT.strip()}]
    extra_context = str(extra_context or "").strip()
    if extra_context:
        parts.append({
            "text": (
                "Additional board-specific inspection context from the operator:\n"
                + extra_context
                + "\nUse this context to avoid false failures, but still fail any fatal "
                "defect that would make the board unreliable or nonfunctional."
            )
        })
    for image in images:
        name = image.get("name", "unknown")
        mime_type = image.get("mime_type", "image/jpeg")
        data = image.get("data", "")
        if not data:
            continue
        parts.append({"text": "Image name: {}".format(name)})
        parts.append({"inline_data": {"mime_type": mime_type, "data": data}})

    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
        },
    }

    request_body = json.dumps(payload).encode("utf-8")
    api_request = request.Request(
        endpoint,
        data=request_body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with request.urlopen(api_request, timeout=90) as response:
            response_body = response.read().decode("utf-8")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError("Gemini API HTTP {}: {}".format(error.code, detail))
    except URLError as error:
        raise RuntimeError("Gemini API connection failed: {}".format(error.reason))

    raw_result = json.loads(response_body)
    text = extract_gemini_text(raw_result)
    parsed = parse_json_text(text)
    return normalize_inspection_result(parsed, model)


def extract_gemini_text(raw_result: Dict) -> str:
    candidates = raw_result.get("candidates") or []
    if not candidates:
        raise RuntimeError("Gemini returned no candidates.")

    content = candidates[0].get("content") or {}
    parts = content.get("parts") or []
    text_parts = [part.get("text", "") for part in parts if part.get("text")]
    text = "\n".join(text_parts).strip()
    if not text:
        raise RuntimeError("Gemini returned an empty response.")
    return text


def parse_json_text(text: str) -> Dict:
    try:
        return json.loads(text)
    except ValueError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if not match:
            raise RuntimeError("Gemini response was not JSON: {}".format(text[:500]))
        return json.loads(match.group(0))


def normalize_inspection_result(parsed: Dict, model: str) -> Dict:
    verdict = str(parsed.get("verdict", "bad")).strip().lower()
    if verdict not in ("good", "bad"):
        verdict = "bad"

    try:
        confidence = float(parsed.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    fatal_defects = parsed.get("fatal_defects") or []
    if not isinstance(fatal_defects, list):
        fatal_defects = []

    if fatal_defects:
        verdict = "bad"

    notes = parsed.get("notes") or []
    if not isinstance(notes, list):
        notes = [str(notes)]

    return {
        "verdict": verdict,
        "passed": verdict == "good",
        "confidence": confidence,
        "summary": str(parsed.get("summary", "")).strip() or "No summary returned.",
        "fatal_defects": fatal_defects,
        "notes": notes,
        "model": model,
    }
