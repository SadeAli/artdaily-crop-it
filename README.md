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

## What changed in the input-fairness pass

Four live bars under the picture move as you drag, so each guideline is
learned by feel instead of one post-mortem at a time. "Power point" is
now "thirds crossing", the lead-room verdict carries its measurement
("34% of the frame in front of it, full credit at 50%"), and clipping the
subject fades from 5 to 0 rather than falling off a cliff — the
lighthouse's beam counts as subject and a beginner does not read it that
way. Scene 1 of a first round opens slightly off-centre, so the
deliberate dead-centre lesson lands on scene 2 instead of punishing a
beginner's instinct before anything has been explained.

## Input fairness

Scores are only ever compared against your own history, so the drill
eases its tolerances for the hardware in your hand and says which one it
eased for (the "scoring for…" chip in the HUD). A pen keeps the strict
reference; a mouse or trackpad, which pivots at the wrist and cannot
creep, gets roughly double the room; a finger sits between. Start and
grab zones move the other way — a screenless tablet needs the *biggest*
targets, because the hand is out of sight. Relative tolerances carry an
absolute pixel floor so a phone is never held to a stricter standard
than a desktop for the same drill.

