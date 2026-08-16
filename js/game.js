/* ============================================================
   game.js — Crop It. A wide painterly scene with known geometry
   (one subject with a facing direction, a horizon, a secondary
   interest object, dead space) is generated on the canvas. The
   player drags a fixed-ratio 3:2 crop window and cuts; curated
   composition rules score the crop against classic guidelines,
   then the reveal overlays a thirds grid, per-rule verdicts and
   a suggested crop. Three scenes per round, mean score.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'crop-it';
  var SCENES_PER_ROUND = 3;

  /* Scene space: 240×100 uniform units (2.4:1) — same length per unit
     on both axes, so distances are Euclidean-honest. All geometry and
     ALL scoring lives in these units; a canvas transform maps to px. */
  var SW = 240, SH = 100;
  var RATIO = 2 / 3;            /* crop height/width — a 3:2 frame  */
  var MIN_W = 60, MAX_W = 150;  /* crop width limits, scene units   */

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnCut = document.getElementById('btnCut');
  var btnUndo = document.getElementById('btnUndo');
  var btnRound = document.getElementById('btnRound');
  var verdictsEl = document.getElementById('verdicts');
  var liveMeterEl = document.getElementById('liveMeter');

  ArtDaily.init({ slug: SLUG });

  /* ============================================================
     Pure scoring — plain numbers in, points out. No canvas, no
     DOM, no state. Each rule: { pts, max, note }. Bands generous.
     ============================================================ */

  /* NaN-safe: every rule funnels its band through here, so degenerate
     geometry (zero-size crops, poisoned coords) scores 0, never NaN. */
  function clamp01(t) { return t > 1 ? 1 : t > 0 ? t : 0; }

  /* written so NaN falls to `lo` rather than propagating — makeCrop
     below must always hand the search a legal frame */
  function clampv(v, lo, hi) { return v > lo ? (v < hi ? v : hi) : lo; }

  function thirdsPoints(crop) {
    return [
      { x: crop.x + crop.w / 3, y: crop.y + crop.h / 3 },
      { x: crop.x + 2 * crop.w / 3, y: crop.y + crop.h / 3 },
      { x: crop.x + crop.w / 3, y: crop.y + 2 * crop.h / 3 },
      { x: crop.x + 2 * crop.w / 3, y: crop.y + 2 * crop.h / 3 },
    ];
  }

  /* a) placement, 0–40: subject's visual centre to the nearest thirds
     intersection, normalized by the crop diagonal. Full inside 0.10,
     gone by 0.23 — dead centre sits at ~0.167 and lands low. */
  function scorePlacement(crop, subject) {
    var diag = Math.hypot(crop.w, crop.h);
    var pts4 = thirdsPoints(crop);
    var d = Infinity, i;
    for (i = 0; i < 4; i++) {
      d = Math.min(d, Math.hypot(subject.cx - pts4[i].x, subject.cy - pts4[i].y));
    }
    var norm = d / diag;
    var pts = Math.round(40 * clamp01((0.23 - norm) / 0.13));
    var dc = Math.hypot(subject.cx - (crop.x + crop.w / 2),
                        subject.cy - (crop.y + crop.h / 2)) / diag;
    var edge = Math.min(
      (subject.cx - crop.x) / crop.w, (crop.x + crop.w - subject.cx) / crop.w,
      (subject.cy - crop.y) / crop.h, (crop.y + crop.h - subject.cy) / crop.h);
    var note;
    if (edge < 0) note = 'subject centre is outside the frame';
    else if (pts >= 36) note = 'subject sits on a thirds crossing — solid';
    else if (dc < 0.06) note = 'dead centre — static; drop it onto a third';
    else if (edge < 0.1) note = 'hugging the edge — pull it back to a third';
    else if (pts >= 20) note = 'near a third — one nudge from strong';
    else note = 'floating between thirds — aim for a crossing';
    return { pts: pts, max: 40, note: note };
  }

  /* b) horizon, 0–25: full near either horizontal third; low when it
     halves the frame or clings to an edge. Cropping it out entirely
     is a legitimate choice — flat 15. */
  function scoreHorizon(crop, horizonY) {
    /* the negated test keeps NaN/zero-height crops on the baseline too */
    if (!(crop.h > 0) || !(horizonY >= crop.y && horizonY <= crop.y + crop.h)) {
      return { pts: 15, max: 25, note: 'no horizon in frame — a fair call' };
    }
    var t = (horizonY - crop.y) / crop.h;
    var e = Math.min(Math.abs(t - 1 / 3), Math.abs(t - 2 / 3));
    var pts = Math.round(25 * clamp01((0.17 - e) / 0.11));
    var note;
    if (pts >= 22) note = 'horizon rides a third — steady';
    else if (t > 0.42 && t < 0.58) note = 'horizon halves the frame — pick a third';
    else if (t < 0.12 || t > 0.88) note = 'a sliver of horizon — lose it or give it a third';
    else note = 'horizon drifts between thirds — commit to one';
    return { pts: pts, max: 25, note: note };
  }

  /* c) breathing room, 0–20: the CLEAR fraction of the crop's width
     ahead of the subject's gaze. The frame edge ends it — and so does
     a secondary element parked in the lead room, which is exactly what
     scene 3 puts there. ≥ 0.5 is full; nothing left by 0.2.
     sec = { x, y, r, label } or null. */
  function scoreBreathing(crop, subject, sec) {
    var ahead = subject.facing > 0
      ? (crop.x + crop.w - subject.cx)
      : (subject.cx - crop.x);
    var blocked = null, dx, gap;
    if (sec) {
      dx = (sec.x - subject.cx) * subject.facing;  /* > 0 ⇒ in the lead room */
      gap = dx - sec.r;
      /* it only blocks if it is actually inside the crop the player cut */
      if (dx > 0 && gap < ahead &&
          sec.y >= crop.y && sec.y <= crop.y + crop.h &&
          sec.x + sec.r > crop.x && sec.x - sec.r < crop.x + crop.w) {
        ahead = gap;
        blocked = sec.label;
      }
    }
    var frac = clamp01(ahead / crop.w);
    var pts = Math.round(20 * clamp01((frac - 0.2) / 0.3));
    /* Put the measurement in the sentence: "lead room" and "breathing
       room" were carrying the whole idea as bare phrases, with nothing
       on screen showing how much of it there was. */
    var pct = Math.round(frac * 100) + '% of the frame in front of it (full credit at 50%)';
    var note;
    if (pts >= 18) note = 'room to look into — ' + pct;
    else if (blocked) note = 'the ' + blocked + ' is in the way of the gaze — crop it out or reframe · ' + pct;
    else if (pts >= 8) note = 'a little cramped in front — slide the frame · ' + pct;
    else note = 'it is staring straight into the frame edge — leave space in front · ' + pct;
    return { pts: pts, max: 20, note: note };
  }

  /* d) integrity, 0–15: whole subject in frame. A 4% margin earns full;
     inside-but-touching stays cheap; clipping FADES to zero rather than
     falling off a cliff. The cliff was unfair in a specific way: the
     lighthouse's measured bounds include its beam, which is painted as a
     0.22-alpha wash a beginner does not read as part of the subject at
     all — so slicing it dropped 5 points to 0 with a note that read as
     arbitrary. A sliver clipped is a sliver's worth of penalty. */
  var CLIP_FADE = 0.05; /* fraction of the crop over which 5 → 0 */
  function scoreIntegrity(crop, subject) {
    if (!(crop.w > 0) || !(crop.h > 0)) return { pts: 0, max: 15, note: 'no frame' };
    var m = Math.min(
      (subject.x0 - crop.x) / crop.w, (crop.x + crop.w - subject.x1) / crop.w,
      (subject.y0 - crop.y) / crop.h, (crop.y + crop.h - subject.y1) / crop.h);
    if (!isFinite(m)) return { pts: 0, max: 15, note: 'subject clipped by the frame' };
    if (m < 0) {
      var over = Math.min(1, -m / CLIP_FADE);
      return {
        pts: Math.round(5 * (1 - over)),
        max: 15,
        note: over >= 1 ? 'a real slice of the subject is outside the frame'
                        : 'the frame just clips the subject — the outline shows what counts as “subject”',
      };
    }
    var pts = Math.round(5 + 10 * clamp01(m / 0.04));
    var note = m >= 0.04 ? 'whole subject, clean margin'
                         : 'whole subject but touching the edge — tight';
    return { pts: pts, max: 15, note: note };
  }

  function scoreScene(crop, scene) {
    var rules = [
      { label: 'placement', r: scorePlacement(crop, scene.subject) },
      { label: 'horizon', r: scoreHorizon(crop, scene.horizonY) },
      { label: 'breathing', r: scoreBreathing(crop, scene.subject, scene.secondary) },
      { label: 'integrity', r: scoreIntegrity(crop, scene.subject) },
    ];
    var total = 0, parts = [], i;
    for (i = 0; i < rules.length; i++) {
      total += rules[i].r.pts;
      parts.push({ label: rules[i].label, pts: rules[i].r.pts,
                   max: rules[i].r.max, note: rules[i].r.note });
    }
    return { total: total, parts: parts };
  }

  /* A legal crop from loose numbers — the search never proposes a
     frame the player could not have dragged. */
  function makeCrop(x, y, w) {
    var ww = clampv(w, MIN_W, Math.min(MAX_W, SW, SH / RATIO));
    var hh = ww * RATIO;
    return { x: clampv(x, 0, SW - ww), y: clampv(y, 0, SH - hh), w: ww, h: hh };
  }

  /* Hill-climb from a grid seed: the four rules are plateau-shaped, so
     a coarse grid lands near the optimum but rarely on it. Steps halve
     from 8 units down to a quarter unit; totals are integers ≤ 100, so
     the climb always terminates (the guard is belt-and-braces). */
  function refineCrop(scene, seed) {
    var MOVES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    var best = seed.crop, bestT = seed.total;
    var step = 8, guard = 0, moved, i, cand, t;
    while (step >= 0.25 && guard < 600) {
      moved = false;
      for (i = 0; i < MOVES.length; i++) {
        guard += 1;
        cand = makeCrop(best.x + MOVES[i][0] * step,
                        best.y + MOVES[i][1] * step,
                        best.w + MOVES[i][2] * step);
        t = scoreScene(cand, scene).total;
        if (t > bestT) { bestT = t; best = cand; moved = true; }
      }
      if (!moved) step /= 2;
    }
    return { crop: best, total: bestT };
  }

  /* Search the same rules for the crop shown in the reveal — doubling
     as proof that a perfect crop exists for the scene. One grid seed
     per frame width, then refine the most promising few. */
  function bestCrop(scene) {
    var seeds = [], best = null;
    var wi, xi, yi, w, h, x, y, t, sBest, sBestT, res;
    for (wi = 0; wi <= 8; wi++) {
      w = MIN_W + (MAX_W - MIN_W) * wi / 8;
      h = w * RATIO;
      sBest = null; sBestT = -1;
      for (xi = 0; xi <= 24; xi++) {
        x = (SW - w) * xi / 24;
        for (yi = 0; yi <= 10; yi++) {
          y = (SH - h) * yi / 10;
          t = scoreScene({ x: x, y: y, w: w, h: h }, scene).total;
          if (t > sBestT) { sBestT = t; sBest = { x: x, y: y, w: w, h: h }; }
        }
      }
      seeds.push({ crop: sBest, total: sBestT });
    }
    seeds.sort(function (a, b2) { return b2.total - a.total; });
    for (wi = 0; wi < seeds.length && wi < 5; wi++) {
      res = refineCrop(scene, seeds[wi]);
      if (!best || res.total > best.total) best = res;
      if (best.total >= 100) break;
    }
    return best;
  }

  /* ============================================================
     Scene generation — everything random is decided here and
     stored, so redraws (theme flips, resizes) are stable.
     ============================================================ */

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function shuffle(a) {
    var i, j, t;
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function placeAway(cx, minDist, lo, hi) {
    var x, tries = 0;
    do { x = rand(lo, hi); tries += 1; } while (Math.abs(x - cx) < minDist && tries < 40);
    return x;
  }

  function makeSubject(kind, cx, horizonY, facing) {
    var sub = { kind: kind, cx: cx, facing: facing };
    var h, w, lean, circ, i, x0, x1, bx, ly;
    if (kind === 'lighthouse') {
      h = Math.min(34, horizonY - 8);
      w = h * 0.42;
      sub.h = h; sub.w = w; sub.beam = 34;
      /* the beam is part of the silhouette the eye reads, so it is part
         of the bounds integrity measures — otherwise a crop that visibly
         slices the beam still scored "whole subject, clean margin" */
      ly = horizonY - h * 0.9;
      bx = cx + facing * sub.beam;
      sub.x0 = Math.min(cx - w * 0.58, bx);
      sub.x1 = Math.max(cx + w * 0.58, bx);
      sub.y0 = Math.min(horizonY - h, ly - 7);
      sub.y1 = horizonY + 4;
      sub.cy = horizonY - h * 0.42;
    } else if (kind === 'tree') {
      h = Math.min(30, horizonY - 8);
      lean = facing * h * rand(0.05, 0.12);
      circ = [
        { dx: lean, dy: h * 0.30, r: h * 0.30 },
        { dx: lean + facing * h * 0.15, dy: h * 0.42, r: h * 0.22 },
        { dx: lean - facing * h * 0.13, dy: h * 0.40, r: h * 0.20 },
      ];
      x0 = cx - h * 0.06; x1 = cx + h * 0.06;
      for (i = 0; i < circ.length; i++) {
        x0 = Math.min(x0, cx + circ[i].dx - circ[i].r);
        x1 = Math.max(x1, cx + circ[i].dx + circ[i].r);
      }
      sub.h = h; sub.lean = lean; sub.circ = circ;
      sub.x0 = x0 - 0.5; sub.x1 = x1 + 0.5;
      sub.y0 = horizonY - h; sub.y1 = horizonY + 2;
      sub.cy = horizonY - h * 0.55;
    } else { /* boat — floats on the water at the horizon */
      sub.x0 = cx - 13; sub.x1 = cx + 13;
      sub.y1 = horizonY + 3; sub.y0 = sub.y1 - 17;
      sub.cy = sub.y1 - 7;
    }
    return sub;
  }

  /* half-width of each painted secondary, in scene units, and the name
     the breathing verdict calls it by */
  var SEC_R = { sun: 5.5, birds: 9.6, island: 13, sail: 5 };
  var SEC_LABEL = { sun: 'sun', birds: 'birds', island: 'island', sail: 'far sail' };

  function makeSecondary(idx, scene) {
    var sub = scene.subject, hz = scene.horizonY, kind, x, y, lo, hi;
    if (idx === 0) {
      /* scene 1: empty sky, at most a far speck of birds */
      if (Math.random() < 0.45) return null;
      kind = 'birds';
      x = placeAway(sub.cx, 80, 20, SW - 20);
    } else if (idx === 1) {
      kind = pick(['sun', 'sail', 'birds', 'island']);
      x = placeAway(sub.cx, 70, 18, SW - 18);
    } else {
      /* scene 3: a competitor parked in the subject's lead room */
      kind = pick(['sail', 'island', 'sun']);
      lo = sub.facing > 0 ? sub.cx + 48 : Math.max(16, sub.cx - 95);
      hi = sub.facing > 0 ? Math.min(SW - 16, sub.cx + 95) : sub.cx - 48;
      x = rand(lo, hi);
    }
    y = kind === 'sun' ? rand(9, Math.max(13, hz - 16))
      : kind === 'birds' ? rand(9, Math.max(13, hz - 22))
      : hz;
    return {
      kind: kind, x: x, y: y, r: SEC_R[kind], label: SEC_LABEL[kind],
      facing: Math.random() < 0.5 ? 1 : -1,
    };
  }

  function makeDeco(scene) {
    var d = { clouds: [], waves: [] }, i, n;
    n = 3 + Math.floor(Math.random() * 3);
    for (i = 0; i < n; i++) {
      d.clouds.push({ x: rand(10, SW - 44), y: rand(8, Math.max(12, scene.horizonY - 14)), len: rand(14, 34) });
    }
    n = 8 + Math.floor(Math.random() * 6);
    for (i = 0; i < n; i++) {
      d.waves.push({ x: rand(6, SW - 30), y: rand(scene.horizonY + 4, SH - 5), len: rand(8, 24) });
    }
    return d;
  }

  function buildScene(idx, kind) {
    var horizonY, span, cx, facing, scene;
    if (idx === 0) horizonY = rand(55, 65);
    else if (idx === 1) horizonY = rand(45, 70);
    else horizonY = Math.random() < 0.5 ? rand(26, 36) : rand(68, 78);
    facing = Math.random() < 0.5 ? 1 : -1;
    span = idx === 0 ? [80, 130] : idx === 1 ? [55, 140] : [40, 150];
    cx = rand(span[0], span[1]);
    if (facing < 0) cx = SW - cx; /* keep ≥ ~90 units of lead room */
    scene = { idx: idx, horizonY: horizonY, subject: makeSubject(kind, cx, horizonY, facing) };
    scene.secondary = makeSecondary(idx, scene);
    scene.deco = makeDeco(scene);
    return scene;
  }

  /* Regenerate until the search proves a full-100 crop exists, so the
     scene can never cap the round below a perfect score. */
  function makeScene(idx, kind) {
    var tries, s2, res, keep = null, keepRes = null;
    for (tries = 0; tries < 12; tries++) {
      s2 = buildScene(idx, kind);
      res = bestCrop(s2);
      if (!keep || res.total > keepRes.total) { keep = s2; keepRes = res; }
      if (keepRes.total >= 100) break;
    }
    keep.best = keepRes;
    return keep;
  }

  /* ---- theme-aware inks (re-read on every repaint) ---- */

  function hexRGB(h) {
    if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function mixHex(a, b, wa) {
    var ca = hexRGB(a), cb = hexRGB(b), out = '#', i, v;
    if (!ca || !cb) return a;
    for (i = 0; i < 3; i++) {
      v = Math.round(ca[i] * wa + cb[i] * (1 - wa));
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }

  function inks() {
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--coral').trim();
    /* the stylesheet's sticker recipe: accent inked 55/45 toward
       graphite on paper so canvas annotations clear contrast; pure
       accent on the dark sheet, where it already passes. */
    if (ArtDaily.theme() !== 'dark') accent = mixHex(accent, ink, 0.55);
    return {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: accent,
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; the transform maps
     scene units → px, so height tracks width at exactly 2.4:1 ---- */
  var s = 1; /* px per scene unit */
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    var wpx = Math.max(1, Math.round(rect.width));
    s = wpx / SW;
    var hpx = Math.round(SH * s);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(wpx * dpr);
    canvas.height = Math.round(hpx * dpr);
    canvas.style.height = hpx + 'px';
    ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
  }
  function lw(px) { return px / s; } /* line width in px regardless of scale */

  /* ---- round state ---- */
  var round = 0, sceneIdx = 0, sceneScores = [], kinds = [];
  var scene = null, phase = 'crop'; /* 'crop' | 'reveal' */
  var crop = null;                  /* { x, y, w } — h derived from RATIO */

  var KIND_LABEL = { lighthouse: 'lighthouse', tree: 'lone tree', boat: 'boat' };

  function cropRect() { return { x: crop.x, y: crop.y, w: crop.w, h: crop.w * RATIO }; }

  /* Normally the frame opens on the classic beginner crop — subject dead
     centre, horizon halving the frame — because scoring low from there IS
     the lesson and the reveal shows the way out.
     The very first scene of a first round is the exception: punishing a
     beginner's own instinct before they have been told anything is how a
     first visit ends. It opens already nudged off centre, so scene 1 is a
     small win and the dead-centre lesson lands on scene 2 instead. */
  function resetCrop() {
    var offX = 0, offY = 0;
    if (round === 1 && sceneIdx === 0) {
      offX = -scene.subject.facing * 22;
      offY = -18 * RATIO;
    }
    crop = {
      x: scene.subject.cx - 48 + offX,
      y: scene.horizonY - 48 * RATIO + offY,
      w: 96,
    };
    clampCrop();
  }

  /* ============================================================
     Painting
     ============================================================ */

  function paintScene(c) {
    var hz = scene.horizonY, d = scene.deco, i;
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = c.muted;
    ctx.fillRect(0, hz, SW, SH - hz);
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = lw(2.5);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (i = 0; i < d.clouds.length; i++) {
      ctx.moveTo(d.clouds[i].x, d.clouds[i].y);
      ctx.lineTo(d.clouds[i].x + d.clouds[i].len, d.clouds[i].y);
      ctx.moveTo(d.clouds[i].x + d.clouds[i].len * 0.2, d.clouds[i].y + 2.4);
      ctx.lineTo(d.clouds[i].x + d.clouds[i].len * 0.75, d.clouds[i].y + 2.4);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.3;
    ctx.lineWidth = lw(1.5);
    ctx.beginPath();
    for (i = 0; i < d.waves.length; i++) {
      ctx.moveTo(d.waves[i].x, d.waves[i].y);
      ctx.lineTo(d.waves[i].x + d.waves[i].len, d.waves[i].y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = lw(1.5);
    ctx.beginPath();
    ctx.moveTo(0, hz);
    ctx.lineTo(SW, hz);
    ctx.stroke();
    if (scene.secondary) paintSecondary(c, scene.secondary, hz);
    paintSubject(c, scene.subject, hz);
    ctx.restore();
  }

  function paintSubject(c, sub, hz) {
    if (sub.kind === 'lighthouse') paintLighthouse(c, sub, hz);
    else if (sub.kind === 'tree') paintTree(c, sub, hz);
    else paintBoat(c, sub, hz);
  }

  function paintLighthouse(c, sub, hz) {
    /* the tower's own top, not sub.y0 — the bounds also carry the beam */
    var cx = sub.cx, w = sub.w, hh = sub.h, top = hz - hh;
    var ly = top + hh * 0.1;
    /* The beam points where the light faces — and it counts as part of
       the subject, so its two rays get a drawn edge: a 0.22 wash alone
       sits at 1.5:1 and a player cannot see what integrity is judging. */
    var bx = cx + sub.facing * sub.beam;
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = c.muted;
    ctx.beginPath();
    ctx.moveTo(cx, ly);
    ctx.lineTo(bx, ly - 7);
    ctx.lineTo(bx, ly + 5);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = lw(1.25);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx, ly - 7);
    ctx.lineTo(cx, ly);
    ctx.lineTo(bx, ly + 5);
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.ellipse(cx, sub.y1 - 2, w * 0.55, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.31, hz + 1);
    ctx.lineTo(cx - w * 0.18, top + hh * 0.2);
    ctx.lineTo(cx + w * 0.18, top + hh * 0.2);
    ctx.lineTo(cx + w * 0.31, hz + 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(cx - w * 0.26, top + hh * 0.16, w * 0.52, hh * 0.05);
    ctx.fillRect(cx - w * 0.13, top + hh * 0.05, w * 0.26, hh * 0.12);
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.17, top + hh * 0.05);
    ctx.lineTo(cx, top);
    ctx.lineTo(cx + w * 0.17, top + hh * 0.05);
    ctx.closePath();
    ctx.fill();
  }

  function paintTree(c, sub, hz) {
    var h = hz - sub.y0, i, cc;
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.ellipse(sub.cx, hz + 1, h * 0.5, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = Math.max(lw(2.5), h * 0.07);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sub.cx, hz + 1);
    ctx.quadraticCurveTo(sub.cx + sub.lean * 0.3, sub.y0 + h * 0.6,
                         sub.cx + sub.lean, sub.y0 + h * 0.34);
    ctx.stroke();
    for (i = 0; i < sub.circ.length; i++) {
      cc = sub.circ[i];
      ctx.beginPath();
      ctx.arc(sub.cx + cc.dx, sub.y0 + cc.dy, cc.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function paintBoat(c, sub, hz) {
    var f = sub.facing, cx = sub.cx;
    var deckY = sub.y1 - 5, botY = sub.y1 - 1;
    var stern = cx - f * 11, bow = cx + f * 12;
    var mx = cx - f * 2;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = c.ink;
    ctx.strokeStyle = c.ink;
    ctx.beginPath();
    ctx.moveTo(stern, deckY);
    ctx.lineTo(stern + f * 2.5, botY);
    ctx.lineTo(bow - f * 4, botY);
    ctx.lineTo(bow, deckY - 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = lw(1.5);
    ctx.beginPath();
    ctx.moveTo(mx, deckY);
    ctx.lineTo(mx, sub.y0 + 1);
    ctx.stroke();
    ctx.beginPath(); /* sail bellies toward the bow */
    ctx.moveTo(mx + f * 0.8, sub.y0 + 1.5);
    ctx.quadraticCurveTo(mx + f * 8.5, sub.y0 + 8, mx + f, deckY - 1);
    ctx.closePath();
    ctx.fill();
  }

  function paintSecondary(c, sec, hz) {
    var i, bx, by, f2 = sec.facing || 1;
    ctx.save();
    ctx.fillStyle = c.muted;
    ctx.strokeStyle = c.muted;
    if (sec.kind === 'sun') {
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(sec.x, sec.y, 5.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (sec.kind === 'birds') {
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = lw(1.5);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (i = 0; i < 3; i++) {
        bx = sec.x + i * 7 - 7;
        by = sec.y + (i % 2) * 2.5;
        ctx.moveTo(bx - 2.6, by + 1.4);
        ctx.quadraticCurveTo(bx - 1.2, by - 1, bx, by + 0.6);
        ctx.quadraticCurveTo(bx + 1.4, by - 1, bx + 2.6, by + 1.4);
      }
      ctx.stroke();
    } else if (sec.kind === 'island') {
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.ellipse(sec.x, hz + 0.5, 13, 3.4, 0, Math.PI, Math.PI * 2);
      ctx.closePath();
      ctx.fill();
    } else { /* small distant sail */
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(sec.x - 4.5, hz - 0.6);
      ctx.lineTo(sec.x + 4.5, hz - 0.6);
      ctx.lineTo(sec.x + 3, hz + 1.2);
      ctx.lineTo(sec.x - 3, hz + 1.2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(sec.x + f2 * 0.5, hz - 1.6);
      ctx.lineTo(sec.x + f2 * 0.5, hz - 8.5);
      ctx.lineTo(sec.x + f2 * 5, hz - 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function scrim(c, r) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = c.card;
    ctx.fillRect(0, 0, SW, r.y);
    ctx.fillRect(0, r.y + r.h, SW, SH - r.y - r.h);
    ctx.fillRect(0, r.y, r.x, r.h);
    ctx.fillRect(r.x + r.w, r.y, SW - r.x - r.w, r.h);
    ctx.restore();
  }

  function strokeThirds(r, color, alpha) {
    var i;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw(1);
    ctx.beginPath();
    for (i = 1; i <= 2; i++) {
      ctx.moveTo(r.x + r.w * i / 3, r.y);
      ctx.lineTo(r.x + r.w * i / 3, r.y + r.h);
      ctx.moveTo(r.x, r.y + r.h * i / 3);
      ctx.lineTo(r.x + r.w, r.y + r.h * i / 3);
    }
    ctx.stroke();
    ctx.restore();
  }

  function corners(r) {
    return [
      { id: 'nw', x: r.x, y: r.y },
      { id: 'ne', x: r.x + r.w, y: r.y },
      { id: 'sw', x: r.x, y: r.y + r.h },
      { id: 'se', x: r.x + r.w, y: r.y + r.h },
    ];
  }

  function paintCropUI(c) {
    var r = cropRect(), pts = corners(r), hs = Math.max(4.5, 15 / s), i;
    scrim(c, r);
    /* The thirds are what the score is measured against, so they are
       meaning-bearing, not decoration: muted at 0.45 sat at 1.9:1 on
       paper (2.2:1 at night) and simply vanished. 0.85 clears the 3:1
       graphics floor on both sheets, over the water wash included. */
    strokeThirds(r, c.muted, 0.85);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = lw(2);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    /* grips in the accent so they read as handles, not decoration */
    ctx.fillStyle = c.card;
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = lw(2);
    for (i = 0; i < 4; i++) {
      ctx.fillRect(pts[i].x - hs / 2, pts[i].y - hs / 2, hs, hs);
      ctx.strokeRect(pts[i].x - hs / 2, pts[i].y - hs / 2, hs, hs);
    }
    /* The move grip, drawn where hitTest actually reserves it. It is an
       affordance, so it has to be visible: 0.65 accent read 2.9:1 on
       paper, 0.9 reads 4.8:1 there and 5.5:1 at night. */
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = lw(1.5);
    ctx.beginPath();
    ctx.moveTo(r.x + r.w / 2 - lw(7), r.y + r.h / 2);
    ctx.lineTo(r.x + r.w / 2 + lw(7), r.y + r.h / 2);
    ctx.moveTo(r.x + r.w / 2, r.y + r.h / 2 - lw(7));
    ctx.lineTo(r.x + r.w / 2, r.y + r.h / 2 + lw(7));
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function paintReveal(c) {
    var r = cropRect(), b = scene.best.crop, sub = scene.subject;
    var fs = Math.max(5.5, 15 / s), lx, ly, label, tw, pts4, near, bd, d, i;
    scrim(c, r);
    /* in the reveal the grid IS the explanation — full strength */
    strokeThirds(r, c.muted, 1);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = lw(2);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = c.accent;
    ctx.strokeStyle = c.accent;
    /* the crossing scorePlacement measured against, and the gap to it —
       "one nudge from strong" now points at which nudge */
    pts4 = thirdsPoints(r);
    near = pts4[0]; bd = Infinity;
    for (i = 0; i < 4; i++) {
      d = Math.hypot(sub.cx - pts4[i].x, sub.cy - pts4[i].y);
      if (d < bd) { bd = d; near = pts4[i]; }
    }
    ctx.lineWidth = lw(1.5);
    ctx.setLineDash([lw(3), lw(3)]);
    ctx.beginPath();
    ctx.moveTo(sub.cx, sub.cy);
    ctx.lineTo(near.x, near.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(near.x, near.y, lw(4), 0, Math.PI * 2);
    ctx.stroke();
    /* the measured subject centre — what "placement" scored */
    ctx.beginPath();
    ctx.arc(sub.cx, sub.cy, lw(3), 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sub.cx, sub.cy, lw(7), 0, Math.PI * 2);
    ctx.stroke();
    /* the suggested crop, labelled with what it would have scored */
    ctx.lineWidth = lw(2.5);
    ctx.setLineDash([lw(8), lw(6)]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    ctx.font = '700 ' + fs + 'px Caveat, cursive';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    label = 'suggested · ' + scene.best.total;
    tw = ctx.measureText(label).width;   /* measured, so it never clips */
    lx = clampv(b.x + 2, 2, Math.max(2, SW - tw - 2));
    ly = b.y - 2;
    if (ly < fs) ly = b.y + fs + 2;
    ctx.fillText(label, lx, ly);
  }

  /* LIVE RULE METER. All four guideline verdicts only appeared after
     "cut it", so the frame was moved blind and the rules could only be
     learned one post-mortem at a time. scoreScene is pure and cheap, so
     it can simply run on every move: the player watches placement,
     horizon, room and integrity respond to the frame under their hand,
     which teaches all four by feel. aria-hidden so a screen reader is
     not read a new number on every pixel — the reveal is the spoken
     version, and it is unchanged. */
  var METER_LABELS = {
    placement: 'on a third',
    horizon: 'horizon',
    breathing: 'room ahead',
    integrity: 'all in frame',
  };

  function updateLiveMeter() {
    if (!liveMeterEl) return;
    if (phase !== 'crop' || !scene || !crop) { liveMeterEl.hidden = true; return; }
    var res = scoreScene(cropRect(), scene), i, p, cell, bar, fill, cap;
    liveMeterEl.innerHTML = '';
    for (i = 0; i < res.parts.length; i++) {
      p = res.parts[i];
      cell = document.createElement('div');
      cell.className = 'lm-cell';
      cap = document.createElement('span');
      cap.className = 'lm-cap';
      cap.textContent = METER_LABELS[p.label] || p.label;
      bar = document.createElement('span');
      bar.className = 'lm-bar';
      fill = document.createElement('i');
      fill.style.width = Math.round(100 * (p.max ? p.pts / p.max : 0)) + '%';
      bar.appendChild(fill);
      cell.appendChild(cap);
      cell.appendChild(bar);
      liveMeterEl.appendChild(cell);
    }
    liveMeterEl.hidden = false;
  }

  /* WHAT THE CANVAS SAYS IT IS. Two problems met here: the label was the
     placeholder "Crop It drill area", and the live meter that finally
     showed the four guidelines responding is aria-hidden — rightly, since
     nobody wants four numbers re-read on every pixel of a drag. So a
     keyboard player had NO feedback at all until after the cut. The
     canvas is a real control (arrows move it, +/- resize, Enter cuts), so
     its accessible name carries the same four readings the bars do, on
     demand rather than shouted, plus the subject and the keys. Written
     only when the string changes. */
  var lastLabel = '';
  function syncCanvasLabel() {
    var s, res, i, p;
    if (!scene) {
      s = 'Crop It drill area';
    } else if (phase === 'reveal') {
      s = 'Crop It, scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND +
        ' — cut and scored; the verdicts are listed below the picture. ' +
        'Press Enter or Space for the next scene.';
    } else {
      res = scoreScene(cropRect(), scene);
      s = 'Crop It, scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND + ' — a ' +
        KIND_LABEL[scene.subject.kind] + ' facing ' +
        (scene.subject.facing > 0 ? 'right' : 'left') + '. Your frame so far:';
      for (i = 0; i < res.parts.length; i++) {
        p = res.parts[i];
        s += ' ' + (METER_LABELS[p.label] || p.label) + ' ' + p.pts + ' of ' + p.max + ',';
      }
      s += ' ' + res.total + ' of 100. Arrow keys move the frame, ' +
        'plus and minus resize it, Enter or Space cuts.';
    }
    if (s === lastLabel) return;
    lastLabel = s;
    canvas.setAttribute('aria-label', s);
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, SW + 2, SH + 2);
    if (!scene) return;
    paintScene(c);
    if (phase === 'crop') paintCropUI(c);
    else paintReveal(c);
    updateLiveMeter();
    syncCanvasLabel();
  }

  /* ============================================================
     Input — pointer drags (move + corner resize) and keyboard
     ============================================================ */

  var drag = null;    /* { id, mode, dx, dy, ax, ay, sx, sy } */
  var live = [];      /* pointer ids currently down on the canvas       */
  var livePos = {};   /* id → point in scene units                      */
  var pinch = null;   /* { d0, mx0, my0, w0, cx0, cy0 }                  */

  function toUnits(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: (ev.clientX - rect.left) / s, y: (ev.clientY - rect.top) / s };
  }

  /* ≥ 44px square hit area, widened for the hardware in hand: a
     screenless tablet cannot see its own cursor, so acquiring a corner
     is the hardest thing it does. */
  function hitR() { return Math.max(7, ArtDaily.startRadius(22) / s); }

  /* THE MOVE GRIP HAS TO CLEAR THE TOUCH FLOOR TOO.
     A flat "middle quarter" was already the fix for widened corner zones
     stranding a shrunken frame — but a quarter is a RATIO, and at the
     minimum crop on a 360px phone a quarter measures 41×27px, under the
     44px floor on its short axis, on the one device where the pointer is
     a fingertip. So the grip is the larger of the quarter and a
     hardware-sized box, capped at MOVE_CAP of the frame so the four
     corner grips always keep a share of it (checked: every corner of
     every crop size stays grabbable on every profile). */
  var MOVE_FACTOR = 0.7;   /* of hitR(), which is already per-hardware */
  var MOVE_CAP = 0.42;     /* of the frame's own half-extent            */

  function moveHalf(r) {
    var g = hitR() * MOVE_FACTOR;
    return {
      x: Math.min(r.w * MOVE_CAP, Math.max(r.w / 4, g)),
      y: Math.min(r.h * MOVE_CAP, Math.max(r.h / 4, g)),
    };
  }

  function hitTest(p) {
    var r = cropRect(), pts = corners(r), i, bestI = -1, bd = hitR(), d;
    var mh = moveHalf(r);
    /* The centre of the frame is ALWAYS the move grip. */
    if (Math.abs(p.x - (r.x + r.w / 2)) < mh.x &&
        Math.abs(p.y - (r.y + r.h / 2)) < mh.y) return 'move';
    for (i = 0; i < 4; i++) {
      d = Math.max(Math.abs(p.x - pts[i].x), Math.abs(p.y - pts[i].y));
      if (d < bd) { bd = d; bestI = i; }
    }
    if (bestI >= 0) return pts[bestI].id;
    if (p.x > r.x - 3 && p.x < r.x + r.w + 3 && p.y > r.y - 3 && p.y < r.y + r.h + 3) return 'move';
    return null;
  }

  /* ---- two-finger pinch: the first gesture anyone tries on a crop ---- */

  function pinchPair() {
    var a = livePos[live[0]], b = livePos[live[1]];
    if (!a || !b) return null;
    return {
      d: Math.max(0.001, Math.hypot(a.x - b.x, a.y - b.y)),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  }

  function startPinch() {
    var q = pinchPair();
    if (!q) return;
    pinch = { d0: q.d, mx0: q.mx, my0: q.my, w0: crop.w,
              cx0: crop.x + crop.w / 2, cy0: crop.y + crop.w * RATIO / 2 };
  }

  function applyPinch() {
    var q = pinchPair(), w;
    if (!q || !pinch) return;
    w = clampv(pinch.w0 * (q.d / pinch.d0), MIN_W, MAX_W);
    crop.w = w;
    crop.x = pinch.cx0 + (q.mx - pinch.mx0) - w / 2;
    crop.y = pinch.cy0 + (q.my - pinch.my0) - w * RATIO / 2;
    clampCrop();
  }

  function clampCrop() {
    crop.w = Math.max(MIN_W, Math.min(crop.w, MAX_W, SW, SH / RATIO));
    crop.x = clampv(crop.x, 0, SW - crop.w);
    crop.y = clampv(crop.y, 0, SH - crop.w * RATIO);
  }

  var lastPenAt = 0;
  canvas.addEventListener('pointerdown', function (ev) {
    /* palm rejection: a pen always beats a palm that landed first */
    if (ev.pointerType === 'pen') lastPenAt = Date.now();
    else if (ev.pointerType === 'touch' && Date.now() - lastPenAt < 500) return;
    /* tapping the picture during the reveal moves on, the same habit
       the sibling drills teach */
    /* clearDiscard so an armed "discard round?" never survives a scene
       change — every other way of advancing already disarms it */
    if (phase === 'reveal') { ev.preventDefault(); clearDiscard(); advance(); return; }
    if (phase !== 'crop') return;
    ev.preventDefault();
    try { canvas.focus({ preventScroll: true }); } catch (e) {}
    var p = toUnits(ev);
    if (live.indexOf(ev.pointerId) < 0) live.push(ev.pointerId);
    livePos[ev.pointerId] = p;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    if (live.length === 2) { drag = null; startPinch(); return; }
    if (live.length > 2 || drag) return;
    var mode = hitTest(p);
    if (!mode) return;
    var r = cropRect();
    drag = { id: ev.pointerId, mode: mode };
    if (mode === 'move') {
      drag.dx = p.x - r.x;
      drag.dy = p.y - r.y;
    } else {
      /* the opposite corner anchors the resize */
      drag.ax = (mode === 'nw' || mode === 'sw') ? r.x + r.w : r.x;
      drag.ay = (mode === 'nw' || mode === 'ne') ? r.y + r.h : r.y;
      drag.sx = (mode === 'ne' || mode === 'se') ? 1 : -1;
      drag.sy = (mode === 'sw' || mode === 'se') ? 1 : -1;
    }
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (phase !== 'crop' || live.indexOf(ev.pointerId) < 0) { updateCursor(ev); return; }
    ev.preventDefault();
    livePos[ev.pointerId] = toUnits(ev);
    if (pinch) { applyPinch(); draw(); return; }
    if (!drag || ev.pointerId !== drag.id) return;
    var p = livePos[ev.pointerId], availW, availH, w;
    if (drag.mode === 'move') {
      crop.x = clampv(p.x - drag.dx, 0, SW - crop.w);
      crop.y = clampv(p.y - drag.dy, 0, SH - crop.w * RATIO);
    } else {
      availW = drag.sx > 0 ? SW - drag.ax : drag.ax;
      availH = drag.sy > 0 ? SH - drag.ay : drag.ay;
      w = Math.max(Math.abs(p.x - drag.ax), Math.abs(p.y - drag.ay) / RATIO);
      w = Math.min(w, availW, availH / RATIO, MAX_W);
      w = Math.max(w, MIN_W);
      crop.w = w;
      crop.x = drag.sx > 0 ? drag.ax : drag.ax - w;
      crop.y = drag.sy > 0 ? drag.ay : drag.ay - w * RATIO;
    }
    draw();
  });

  function endDrag(ev) {
    var i = live.indexOf(ev.pointerId);
    if (i >= 0) live.splice(i, 1);
    delete livePos[ev.pointerId];
    if (drag && ev.pointerId === drag.id) drag = null;
    if (pinch && live.length < 2) pinch = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  /* A LOST RELEASE DOES NOT JUST END A DRAG HERE — IT INVENTS A PINCH.
     `live` is the list of pointers believed to be down, and the next
     pointerdown that takes it to two starts a pinch. So one pointerup the
     canvas never sees leaves a stale id in the list, and the player's very
     next press is read as the second finger of a two-finger gesture:
     startPinch() anchors on a position from a touch that ended minutes
     ago, and the frame jumps and rescales off a distance that was never
     measured. setPointerCapture normally guarantees the release lands
     here, but it is wrapped in a try/catch because it can throw or be
     missing, and then a finger lifted outside the canvas is gone. Caught
     at the window too — bubble phase, so the canvas handler still runs
     first and the id is simply absent by the time this one looks. */
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  function updateCursor(ev) {
    if (drag || pinch) return;
    /* during the reveal the picture IS the next-scene button, so say so
       — 'default' told a mouse user the canvas had gone inert */
    var cur = 'pointer', mode;
    if (phase === 'crop') {
      mode = hitTest(toUnits(ev));
      if (mode === 'nw' || mode === 'se') cur = 'nwse-resize';
      else if (mode === 'ne' || mode === 'sw') cur = 'nesw-resize';
      else if (mode === 'move') cur = 'move';
      else cur = 'crosshair';
    }
    canvas.style.cursor = cur;
  }

  function growCrop(d) {
    var cx0 = crop.x + crop.w / 2, cy0 = crop.y + crop.w * RATIO / 2;
    crop.w = Math.max(MIN_W, Math.min(MAX_W, crop.w + d * 2));
    crop.x = cx0 - crop.w / 2;
    crop.y = cy0 - crop.w * RATIO / 2;
  }

  canvas.addEventListener('keydown', function (ev) {
    var k = ev.key;
    /* SPACE IS AN ACTIVATION KEY, AND THIS CANVAS IS A CONTROL.
       tabindex="0" makes the picture a real keyboard control — arrows move
       the frame, plus/minus resize it — and every sibling canvas drill in
       the arcade activates on `Enter` OR `' '` (focal-place, light-direction
       and value-thumbnail all test both). This one tested Enter alone, so a
       keyboard player who reached for the key every other button on the page
       answers to got the browser's default instead: Space on a focused
       element scrolls the sheet. The frame jumps off screen and nothing is
       cut — which reads as the drill having gone dead.
       A HELD Enter (or Space) auto-repeats straight through cut → next scene
       → cut, cutting frames nobody framed and reporting rounds nobody
       played; only the first press is a press (arrows below still repeat). */
    if (k === 'Enter' || k === ' ') {
      ev.preventDefault();
      if (ev.repeat) return;
      clearDiscard();
      advance();
      return;
    }
    if (k === 'Backspace' || k === 'u' || k === 'U') { ev.preventDefault(); undoCut(); return; }
    if (phase !== 'crop') return;
    var step = ev.shiftKey ? 6 : 2;
    if (k === 'ArrowLeft') crop.x -= step;
    else if (k === 'ArrowRight') crop.x += step;
    else if (k === 'ArrowUp') crop.y -= step;
    else if (k === 'ArrowDown') crop.y += step;
    else if (k === '+' || k === '=') growCrop(step);
    else if (k === '-' || k === '_') growCrop(-step);
    else return;
    ev.preventDefault();
    clampCrop();
    draw();
  });

  /* ============================================================
     Round flow — cut → reveal → next scene → report once
     ============================================================ */

  /* The verb, every time: drag the frame, then cut. */
  function sceneHint() {
    return 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND + ' — frame the ' +
      KIND_LABEL[scene.subject.kind] + ' (facing ' +
      (scene.subject.facing > 0 ? '→' : '←') + '): drag the middle to move it, ' +
      'the corners (or a pinch) to resize — then cut it to score.';
  }

  function setBtnLabel(btn, text, icon) {
    btn.textContent = text + ' ';
    var sp = document.createElement('span');
    sp.setAttribute('aria-hidden', 'true');
    sp.textContent = icon;
    btn.appendChild(sp);
  }

  function showVerdicts(res) {
    var i, row, ptsEl, noteEl;
    verdictsEl.innerHTML = '';
    for (i = 0; i < res.parts.length; i++) {
      row = document.createElement('p');
      row.className = 'v-row';
      ptsEl = document.createElement('span');
      ptsEl.className = 'v-pts';
      ptsEl.textContent = res.parts[i].pts + '/' + res.parts[i].max;
      noteEl = document.createElement('span');
      noteEl.textContent = res.parts[i].label + ' — ' + res.parts[i].note;
      row.appendChild(ptsEl);
      row.appendChild(noteEl);
      verdictsEl.appendChild(row);
    }
    row = document.createElement('p');
    row.className = 'v-row v-total';
    ptsEl = document.createElement('span');
    ptsEl.className = 'v-pts';
    ptsEl.textContent = res.total + '/100';
    noteEl = document.createElement('span');
    noteEl.textContent = 'scene total · the dashed frame is a ' +
      scene.best.total + '/100 crop of the same scene';
    row.appendChild(ptsEl);
    row.appendChild(noteEl);
    verdictsEl.appendChild(row);
    verdictsEl.hidden = false;
  }

  function cut() {
    var res = scoreScene(cropRect(), scene), sum, i, rep;
    sceneScores.push(res.total);
    phase = 'reveal';
    showVerdicts(res);
    if (sceneIdx === SCENES_PER_ROUND - 1) {
      sum = 0;
      for (i = 0; i < sceneScores.length; i++) sum += sceneScores[i];
      rep = ArtDaily.report(sum / SCENES_PER_ROUND); /* the one report per round */
      hudScore.textContent = String(rep.score);
      hudBest.textContent = rep.best === null ? '–' : String(rep.best);
      /* THE HINT IS THE ONLY SPOKEN CHANNEL. The round total reached a
         screen reader through the toast, and the four verdicts through
         their own polite region — three regions written in one tick queue
         instead of merging, so the player heard the scene score, then the
         round score, then the whole critique list, every round. The toast
         is a sticker now and the verdict panel is read on demand (the
         canvas's own label points at it), so this line carries the two
         numbers that are actually news. */
      hint.textContent = 'scene ' + SCENES_PER_ROUND + ': ' + res.total + '/100 — ' +
        (rep.isNewBest ? 'new best! round ' : 'round ') + rep.score +
        '/100, the mean of all three. the verdicts are listed under the picture —' +
        ' study the delta, then go again.';
      showToast((rep.isNewBest ? 'new best! ' : 'round ') + rep.score + ' / 100', rep.isNewBest);
      setBtnLabel(btnCut, 'go again', '↻');
    } else {
      hint.textContent = 'scene ' + (sceneIdx + 1) + ': ' + res.total +
        '/100 — the verdicts are listed under the picture. compare with the dashed crop,' +
        ' then tap the picture for the next scene.';
      setBtnLabel(btnCut, 'next scene', '→');
      /* the cut is only undoable while the round is still unreported */
      btnUndo.hidden = false;
    }
    draw();
  }

  /* Recovery from a premature cut (or a stray Enter): pull the scene
     score back out and re-open the same frame. Never offered on the
     last scene — that one has already been reported. */
  function undoCut() {
    if (phase !== 'reveal' || sceneIdx >= SCENES_PER_ROUND - 1) return;
    sceneScores.pop();
    phase = 'crop';
    verdictsEl.hidden = true;
    /* hiding the button that was just pressed drops keyboard focus onto
       <body> — the next Tab would restart at the back link. Hand it to
       the frame the player has just been given back. */
    if (document.activeElement === btnUndo) {
      try { canvas.focus({ preventScroll: true }); } catch (e) { try { canvas.focus(); } catch (e2) {} }
    }
    btnUndo.hidden = true;
    setBtnLabel(btnCut, 'cut it', '✂');
    hint.textContent = sceneHint();
    draw();
  }

  function nextScene() {
    sceneIdx += 1;
    scene = makeScene(sceneIdx, kinds[sceneIdx]);
    resetCrop();
    phase = 'crop';
    verdictsEl.hidden = true;
    btnUndo.hidden = true;
    setBtnLabel(btnCut, 'cut it', '✂');
    hint.textContent = sceneHint();
    draw();
  }

  function newRound() {
    clearDiscard();
    round += 1;
    sceneIdx = 0;
    sceneScores = [];
    kinds = shuffle(['lighthouse', 'tree', 'boat']);
    scene = makeScene(0, kinds[0]);
    resetCrop();
    phase = 'crop';
    verdictsEl.hidden = true;
    btnUndo.hidden = true;
    setBtnLabel(btnCut, 'cut it', '✂');
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = sceneHint();
    draw();
  }

  /* "cut it ✂" changes job in place (cut → next scene →), and the picture
     and the Enter key are the same action, so the second click of an
     accidental double-click — or one auto-repeat of a held Enter — fires
     the NEW job and takes the verdicts, the dashed "suggested" crop and
     the undo with it. One guard on the action itself covers all three
     paths (button, canvas tap, keyboard). */
  var ACTION_GUARD_MS = 250;
  var actionAt = 0;

  function advance() {
    var now = Date.now();
    if (now - actionAt < ACTION_GUARD_MS) return;
    actionAt = now;
    if (phase === 'crop') cut();
    else if (sceneIdx < SCENES_PER_ROUND - 1) nextScene();
    else newRound();
  }

  /* ---- "new round" mid-round throws away scored scenes, so it asks
     once before it does; the arming lapses on its own. ---- */
  /* THE ARMING WAS INVISIBLE TO ANYONE NOT WATCHING THE BUTTON. Its only
     signal was the button's own label, and a name that changes under a
     focused button is not re-announced by any screen reader — so the press
     read as "nothing happened", and a player who then waited out the
     window pressed again, re-armed, heard nothing again, and could never
     reach a new round at all. The hint is this drill's live region, so the
     arming is said there; the line it replaced goes back when the arming
     lapses, unless something newer (a cut, an undo) already claimed it. */
  var discardArmed = false, discardTimer = null, discardSaid = '', hintBeforeDiscard = '';

  function clearDiscard() {
    clearTimeout(discardTimer);
    discardTimer = null;
    if (!discardArmed) return;
    discardArmed = false;
    setBtnLabel(btnRound, 'new round', '↻');
    if (discardSaid && hint.textContent === discardSaid) hint.textContent = hintBeforeDiscard;
    discardSaid = '';
  }

  function roundAtRisk() {
    return sceneScores.length > 0 &&
      !(phase === 'reveal' && sceneIdx === SCENES_PER_ROUND - 1);
  }

  function onRoundClick() {
    if (discardArmed || !roundAtRisk()) { newRound(); return; }
    discardArmed = true;
    setBtnLabel(btnRound, 'discard round?', '↻');
    hintBeforeDiscard = hint.textContent;
    discardSaid = 'that scraps this round — press “new round” again to start over, or carry on.';
    hint.textContent = discardSaid;
    clearTimeout(discardTimer);
    /* 3.5s is not long enough to hear a polite announcement AND press */
    discardTimer = setTimeout(clearDiscard, 4500);
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var sp = document.createElement('span');
    sp.className = celebrate ? 'toast-accent' : '';
    sp.textContent = msg;
    toast.appendChild(sp);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  btnCut.addEventListener('click', function () { clearDiscard(); advance(); });
  btnUndo.addEventListener('click', function () { clearDiscard(); undoCut(); });
  btnRound.addEventListener('click', onRoundClick);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () { fitCanvas(); draw(); });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
