# CONDUCTOR tests

Headless-chromium verification over the Chrome DevTools Protocol. **33 checks,
no camera and no microphone required** — the whole point is to prove CONDUCTOR
degrades gracefully and that the bridge protocol is correct on a machine with
no capture hardware.

## Running

```bash
# 1. serve the app
cd .. && ./launch.sh bg

# 2. install ws (the only dependency) and run
cd tests && npm install && node harness.js
```

Expected: `33/33 passed`, exit code 0.

## What it covers

| Group | Checks |
| --- | --- |
| **T1** boot | title, zero console errors, zero warnings, no 404s |
| **T2** no-camera | stage shows a state, START click → error state not a crash |
| **T3** catalog | 50 sources, all 5 groups, ids namespaced, entries well-formed |
| **T4** values | every value is a number within 0..1 |
| **T5** UI | 50 bars rendered, count readout, 5 FX sliders, monitor gated, warning shown |
| **T6** bridge | a *second page* receives hello + catalog, `ping` → `pong` |
| **T7** peers | CONDUCTOR discovers the listener and shows it in the BRIDGE panel |
| **T8** idle | a stopped producer sends no `sources` frames (heartbeat only) |
| **T9** events | a pulse spikes to 1 and returns to 0 within ~150 ms |
| **T10** MediaPipe | versions pinned (not `@latest`), model URL, GPU→CPU fallback |

T6–T8 are the interesting ones: they drive a real second browser page
(`test.html`) and assert on what it actually received, so the protocol is
verified end to end rather than by inspecting the producer's internals.

## Not covered — needs a human

Headless chromium has no webcam or microphone, so these cannot be automated
here:

- **Hand tracking** — landmark accuracy, overlay alignment, source feel/range
- **Swipe & pinch thresholds** — whether they fire when a performer expects
- **Microphone** — pitch tracking, onset sensitivity, FX audio quality
- **Monitoring/feedback** behaviour
- **End-to-end latency** — hand movement → consumer pixel

A `--use-fake-device-for-media-capture` run would exercise the code paths but
tells you nothing about whether the gestures *feel* right, which is the part
that matters for an instrument.
