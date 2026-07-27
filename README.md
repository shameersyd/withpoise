# Yoga Pose Tracker

A browser-based yoga assistant. It shows you how to do a pose, then watches you
through your phone camera and gives live feedback on your form.

- **Learn first** — every pose opens with an animated stick-figure walkthrough that
  steps through the instructions, highlighting the body part each step is about.
- **Get framed** — tracking waits until your whole body is in shot, then counts you in.
- **Live correction** — a dashed target outline is rebuilt from your own limb lengths
  and pinned to your hips, so a correct pose lands right on top of it. It turns red
  where a joint is out of tolerance and green where it isn't; when everything is
  correct the whole figure goes green.
- **Score** — a running percentage, a plain-language verdict, and a list of the
  specific adjustments to make, with arrows pointing each joint where it belongs.

Five poses: Mountain, Warrior I, Warrior II, Tree and Triangle.

## Running it locally

```
python3 serve.py
```

This serves `yoga_app/` over HTTPS on port 8443 with a self-signed certificate —
browsers require a secure origin for camera access. Open the printed URL on your
phone (same Wi-Fi) and accept the certificate warning.

For sharing, deploy `yoga_app/` to any static host instead; it needs no backend.

## How it works

Pose detection is [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
running in the browser via WebAssembly. Each pose is defined by target angles at
eight joints with a per-joint tolerance, plus a rig of segment directions that the
demo figure and the target outline are both built from — so what you're shown and
what you're scored against are the same shape.

**Nothing leaves your device.** The model runs client-side; no video or pose data is
ever uploaded.
