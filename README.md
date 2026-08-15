# Crop It — an Art Daily drill

Find the strongest crop of the scene. A wide painterly vista (lighthouse,
lone tree or boat — each with a facing direction) is generated with known
geometry; drag a fixed 3:2 frame and cut. Trains compositional judgement:
thirds, horizon placement, breathing room, and not amputating the subject.

Scoring per scene (sum 0–100, round = mean of 3): subject on a thirds
crossing (40) · horizon on a third (25, flat 15 if cropped out — a valid
call) · lead room ahead of the gaze (20) · whole subject with margin (15).
The reveal overlays your thirds grid, per-rule verdicts and a suggested crop.

Run: `python3 -m http.server 8080` in this folder. No build, no deps, no network.

Part of [Art Daily](https://artdaily.sadeali.com/) · more at [sadeali.com](https://sadeali.com/)
