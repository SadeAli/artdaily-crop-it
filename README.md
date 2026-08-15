# Crop It — an Art Daily drill

Find the strongest crop of the scene. A wide painterly vista (lighthouse,
lone tree or boat — each with a facing direction) is generated with known
geometry; drag a fixed 3:2 frame and cut. Trains compositional judgement:
thirds, horizon placement, breathing room, and not amputating the subject.

Grab the middle of the frame to move it, a corner — or a two-finger pinch —
to resize. Arrows nudge, `+`/`−` resize, enter cuts, backspace undoes a cut
on scenes 1–2 (the last scene is already scored, so it stays put).

Scoring per scene (sum 0–100, round = mean of 3): subject on a thirds
crossing (40) · horizon on a third (25, flat 15 if cropped out — a valid
call) · clear lead room ahead of the gaze (20 — a secondary element parked
in front of the gaze cuts the room short, so crop it out or reframe) ·
whole subject with margin (15, and the lighthouse's beam is part of the
subject). Every scene is regenerated until a search proves a full-100 crop
of it exists, so a perfect round is always reachable.

The reveal overlays your thirds grid, per-rule verdicts, the crossing your
subject was measured against, and a suggested crop labelled with its own
score. Tap the picture to move on.

Run: `python3 -m http.server 8080` in this folder. No build, no deps, no network.

Part of [Art Daily](https://artdaily.sadeali.com/) · more at [sadeali.com](https://sadeali.com/)
