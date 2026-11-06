# Project Analysis & Change Notes (AI working log)

> Purpose of this file: personal working notes for AI-assisted changes on this repo.
> Section 1 = project analysis. Section 2 = change log — **every file I modify gets an entry
> with a purpose summary.** Newest entries at the top of the log.

---

## 1. Project analysis

### 1.1 What this project actually is
An **AR Studio** (marker-based image-tracking): create projects → upload target images →
upload 3D models (glb/gltf) → compose an AR experience (position/rotation/scale) →
publish a public link → end user opens `/view/<id>`, camera tracks the printed image
with **OpenCV.js in the browser** and anchors a Three.js model on it.

**Note:** despite the repo name `AR_calander_with_django`, there is **no calendar feature**
anywhere. The name is stale.

### 1.2 Tech stack
| Layer | Tech | Key versions |
|---|---|---|
| Backend | Django + DRF + drf-spectacular + jazzmin | Django 6.1.1, DRF 3.18.1 |
| DB | PostgreSQL | 16 (compose) |
| CV (server) | opencv-python-headless (ORB + homography) | 4.11 |
| Frontend | React + Vite (plain JS/JSX, no TS) | React 19, Vite 8, react-router-dom 7 |
| 3D / AR | three.js + GLTFLoader + OpenCV.js (CDN) | three 0.186, opencv-js 5.0 |
| Lint | oxlint | `npm run lint` |
| Deploy | Docker Compose: `db` → `web` (gunicorn) → `nginx` (SPA + proxy) | nginx 1.27 |

### 1.3 Architecture / connectivity
- Same-origin design, **no CORS package**. API base is hardcoded `/api`
  (`ar-studio-frontend/src/api.js:27`).
- Dev: Vite on :5173 proxies `/api` + `/media` → `http://127.0.0.1:8000`
  (`ar-studio-frontend/vite.config.js:6-11`); Django `runserver` on :8000.
- Prod: nginx serves SPA, proxies `/api/` + `/admin/` → `http://web:8000`,
  serves `/static/` + `/media/` from shared volumes
  (`deploy/nginx/default.conf`). SPA fallback `try_files ... /index.html`.
- Absolute media URLs from DRF are relativized by a `rel()` helper —
  duplicated in `ProjectDetail.jsx`, `Viewer.jsx`, `PreviewViewport.jsx`.

### 1.4 Backend map (`AR_cal/`)
- Project pkg: `AR_cal/AR_cal/{settings,urls,wsgi,asgi}.py`; single app: `AR_cal/api/`.
- **Models** (`api/models.py`): `User(AbstractUser)` (`:7`, AUTH_USER_MODEL),
  `Project` (`:24`, UUID pk + slug w/ collision loop), `TargetImage` (`:62`,
  `tracking_data` JSON cache of ORB features), `ModelAsset` (`:93`),
  `ARExperience` (`:118`, target+model FKs PROTECT, transform fields, `clean()`),
  `PublishedExperience` (`:181`, public_id + slug), `QRCode` (`:215`, **unused**).
- **Serializers** (`api/serializer.py`): ownership checks per project, scale > 0,
  `published_slug` method field.
- **Views** (`api/views.py`): viewsets for projects/targets/assets/experiences
  (all `IsAuthenticated`, scoped to `request.user`); `register_target` runs OpenCV
  server-side; `track_image` (`:112`) = server CV endpoint **never used by frontend**.
- **Auth/publish** (`api/views_auth.py`): Django **session auth + CSRF**
  (GET `/api/auth/csrf/` → cookie; `X-CSRFToken` on non-GET; `credentials: 'include'`).
  Endpoints: csrf/register/login/logout/me, experiences `<pk>/publish|unpublish`,
  anonymous `/api/public/<public_id>/`.
- **CV service** (`api/service/image_tracker.py`): ORB(1500) → BFMatcher knn k=2,
  Lowe 0.75 → `findHomography(RANSAC 5.0)` → ≥8 inliers.
- **Settings** (`AR_cal/AR_cal/settings.py`): python-decouple env config,
  Postgres DB, DRF defaults (Session+Basic auth, no pagination),
  `AUTH_USER_MODEL = api.User`, static/media roots, secure cookies when `not DEBUG`.
- URLs: root `AR_cal/AR_cal/urls.py:29` (admin, api, schema/docs/redoc, media in DEBUG);
  routes `AR_cal/api/urls.py:24` (DefaultRouter + custom actions).

### 1.5 Frontend map (`ar-studio-frontend/src/`)
- `main.jsx` → `BrowserRouter > AuthProvider > App`; theme in `localStorage.theme`.
- Routes (`App.jsx:66`): `/view/:publicId` (public Viewer), `/login`,
  `/` (Projects), `/projects/:id` (ProjectDetail, Protected+Shell), `*` → `/`.
- `api.js` — fetch wrapper: CSRF fetch/inject, JSON/FormData, error flattening.
- `auth.jsx` — AuthContext `{user, loading, login, register, logout}` via `/api/auth/me/`.
- `pages/Projects.jsx` — project list + published share links.
- `pages/ProjectDetail.jsx` (484 lines) — the studio: TargetsPanel (upload + Register),
  AssetsPanel (glb/gltf), InspectorPanel (create experience, transform sliders → PATCH,
  publish with custom slug), `Slider`.
- `components/PreviewViewport.jsx` — three.js editor preview (orbit, theme-aware grid,
  textured target plane, GLB auto-fit, live transform).
- `ar/tracker.js` — browser `ImageTracker`: ORB compile/track, ratio 0.75,
  RANSAC homography, min 10 matches (differs from server's 8).
- `ar/pose.js` — `poseFromHomography(H, w, h, fov=60°)` → camera matrix for three.js;
  `smoothCorners` exponential smoothing.
- `pages/Viewer.jsx` — public AR runtime: load public JSON → wait OpenCV.js CDN
  (25 s timeout) → `getUserMedia(environment)` → track loop → transparent WebGL over
  video → GLB + published transform → HUD (fps, tracking state).

### 1.6 Deploy
- `docker-compose.yml`: `db` (postgres:16-alpine, healthcheck) → `web` (build `./AR_cal`,
  no host ports, volumes staticfiles + ./AR_cal/media) → `nginx` (build via
  `ar-studio-frontend/Dockerfile`, `${HTTP_PORT:-80}:80`).
- `AR_cal/entrypoint.sh`: wait-for-DB → `migrate` → `collectstatic` → gunicorn :8000.
- Frontend Dockerfile: 2-stage node:22 build → nginx:1.27 with `deploy/nginx/default.conf`.
- Root `.env.example` supplies compose substitution (no root `.env` present).
  Local dev uses `AR_cal/.env` (python-decouple, gitignored).

### 1.7 Known issues (candidates for fixes)
1. **Broken migrations for fresh clones** — `0002_experience_name_slug.py` and
   `0003_state_sync.py` are **untracked** in git; they use `SeparateDatabaseAndState`
   with empty `database_operations` (DB evolved manually). A fresh clone only runs
   `0001` → schema won't match models.
2. **Secure cookies over plain HTTP** — `settings.py:127-133` sets
   `SESSION_COOKIE_SECURE`/`CSRF_COOKIE_SECURE` when `DEBUG=False`, but compose serves
   HTTP:80 → login/session breaks; also `getUserMedia` needs a secure context.
3. Dead/half code: server `track_image` endpoint, `QRCode` model,
   `User.phone_number`/`profile_image`, invalid `MAILERS` dict in `settings.py:139`
   (not a Django setting).
4. `register` in `views_auth.py` can 500 on duplicate username (no uniqueness check).
5. Unhandled promise rejections on delete actions (`Projects.jsx`, `ProjectDetail.jsx`);
   `notice` never cleared in ProjectDetail.
6. `rel()` helper duplicated in 3 files; tracking tunables differ server (8 matches,
   1500 frame feats) vs client (10 matches, 900 frame feats).
7. Repo hygiene: committed `__pycache__/*.pyc`, duplicate 55 MB GLB in `media/`,
   unused `public/images/logo.png`, empty `src/assets/`, root `*.log` files,
   no root README, zero tests, Python version skew (venv 3.14 / Docker 3.13 / .pyc 3.13).
8. nginx starts before `collectstatic` (no healthcheck dependency) → possible static 404s.

---

## 2. Change log

Format: date · file · purpose summary · status.

| Date | File(s) | Purpose of change | Status |
|---|---|---|---|
| 2026-11-06 | `src/ar/faceMesh.js` (new), `src/ar/faceStage.js`, `src/ar/cameraStage.js`, `src/ar/anchors.js`, `src/components/TrackingStage.jsx`, `src/pages/TrackingStudio.jsx`, `src/pages/TrackingViewer.jsx`, `src/styles.css`, `AR_cal/api/anchors.py`, `api/serializer.py`, `api/tests.py` | **Face markers + face masks.** Ortho overlay in video-pixel space (x=lm.x·W, y=−lm.y·H, z=−lm.z·W) draws the 478 landmarks (points), 1322 unique tessellation edges and feature contours (eyes/brows/lips/oval/irises); toggles saved in face `type_settings` (`show_points/show_mesh/show_contours`) and shown to viewers. New face point `mesh` = image mask on the deforming 852-triangle mesh (triangles = every 3 consecutive TESSELATION connections, verified 852/852); UVs = landmarks de-rotated by the head matrix, square-normalised, U mirrored for selfie view, re-captured only when more frontal; opacity stored in scale_x. Camera stage now has underlays (masks, under 3D models) and overlays (markers). Studio: marker toggles, "Download face mask template" (PNG from captured UV layout), opacity slider. Backend: `mesh` requires an image asset. Verified: 7 Django tests, Node test of mesh layer (9 checks), build + lint. NOT verified in a browser/device. | done (needs device test) |
| 2026-11-06 | Backend: `api/anchors.py` (new), `api/game_logic.py` (new), `api/models.py`, `api/serializer.py`, `api/views_auth.py`, `api/tests.py`, `api/migrations/0006_project_types_and_anchors.py` (new). Frontend: `src/ar/{anchors,mediapipe,cameraStage,faceStage,objectStage,contentLoader,gameEngine,scriptSandbox}.js` (new), `src/components/{NewProjectWizard,AssetsPanel,LogicEditor,TrackingStage}.jsx` (new), `src/pages/{TrackingStudio,TrackingViewer}.jsx` (new), `src/pages/{Projects,ProjectDetail,Viewer}.jsx`, `src/components/{GameSettingsPanel,PreviewViewport}.jsx`, `src/ar/mediaPanel.js`, `src/styles.css`, `package.json` (+`@mediapipe/tasks-vision@1.1.1`) | **Project types.** `Project.project_type` (image_ar/game/face/object, fixed after create) + `type_settings` (face: default_point, occlusion; object: default_label, min_confidence, show_labels) chosen in a 2-step new-project wizard. `ExperienceItem.target_image` now nullable + `anchor_type`/`anchor_value` (face point or COCO label), forced from project type and validated. Assets: + png/jpg/jpeg/webp (placeable image panels) and mp3/wav/ogg (game sounds, not placeable). **AR Game:** `Project.game_logic` {variables, rules (event→conditions→actions), script_enabled, script} validated by whitelist; published in `game.logic` (game projects are always games) with `sounds`. Viewer runs `gameEngine` (rules; "reaches" fires on crossing either direction; every/after timers; spin/move tweens restored on restart) + `scriptSandbox` (blob Web Worker, network/storage globals removed incl. prototype chain, command whitelist, 400 cmd/s cap, heartbeat kill after 4s). Studio: "Edit game logic" modal (Rules / Variables / Script tabs). **Face / Object:** MediaPipe Face Landmarker (facial transformation matrix, 63° FOV, cm units, pose smoothing, optional ellipsoid occluder) and Object Detector (EfficientDet-Lite0, ~20 Hz, content scaled to bbox height at depth 1, optional boxes). Shared `cameraStage` (cover layout, mirror for selfie). `TrackingStudio` with live camera preview for placement; `TrackingViewer` public page with start card; `Viewer` default export now loads once and routes by type. Face point offsets are estimates — tune on device. WASM/models load from jsDelivr/Google Storage (self-host for offline). Verified: 6 Django API tests, Node test of engine + sandbox (16 checks), build + lint. NOT verified in a browser or on a device. | done (needs device test) |
| 2026-11-06 | `AR_cal/api/models.py`, `api/serializer.py`, `api/views_auth.py`, `api/migrations/0005_project_game_settings.py` (new), `src/ar/game.js` (new), `src/components/GameSettingsPanel.jsx` (new), `src/pages/Viewer.jsx`, `src/pages/ProjectDetail.jsx`, `src/styles.css` | AR game step 3 — game rules. New nullable `Project.game_settings` `{enabled, goal: none/score/collect_all, target_score, time_limit (0–3600s), intro, win_message, lose_message}` validated by `clean_game_settings()`; `game_payload()` (only when enabled) is frozen into both publish snapshots (project + legacy experience) and returned as `game` by `public_experience`. Studio: "Game" inspector section with hints (no scorers / no collectibles). Viewer: intro card → Start (resets score & start-hidden visibility, unlocks audio) → playing (taps ignored outside play; clock starts on first target lock) → won/lost/over card with Play again; score shows `/target`; collect_all = all items with `hide_self` hidden. Migration applied to local DB. Build + lint pass; validator checked in shell; NOT verified on device. | done (needs device test) |
| 2026-11-06 | `AR_cal/api/models.py`, `api/serializer.py`, `api/migrations/0004_experienceitem_behaviors.py` (new), `src/ar/behaviors.js` (new), `src/components/BehaviorsPanel.jsx` (new), `src/ar/interaction.js`, `src/pages/Viewer.jsx`, `src/pages/ProjectDetail.jsx`, `src/styles.css` | AR game step 2 — tap behaviours. New nullable `ExperienceItem.behaviors` JSON `{start_hidden, on_tap:[{action,value}]}`, validated by `clean_behaviors()` (whitelisted actions: toggle/play animation, hide self, show/hide/toggle another item, add score, play sound pop/chime/success/fail, show message; max 10) and included in the published item payload. Studio: "Tap actions" inspector section (real items only) edits rules, holds incomplete rules locally until valid. Viewer: runs rules on tap (no rules = old play/pause default), start-hidden items, hidden items not tappable, score pill shown only if some item uses add_score, message toast, WebAudio-synthesised sounds. Migration applied to local DB. Must **republish** for changes to reach the public link (snapshot). Build + lint pass; validator checked in shell; NOT verified on device. | done (needs device test) |
| 2026-11-06 | `src/ar/interaction.js` (new), `src/pages/Viewer.jsx` | AR game groundwork, step 1 — tap-to-interact: pointer tap (≤12px move, ≤400ms) on viewer root, ignoring UI elements, raycasts via GL canvas bounding rect (handles cover layout) against each item's `fit` group on visible anchors only; contact shadows flagged `userData.noTap`. On hit: squash/stretch bounce, short vibrate, toggles that item's animation and makes it the active controller in the Animations panel; dispatches `window` `ar-item-tap` CustomEvent `{itemId, itemName}` for future behaviours/game logic. Build + lint pass; NOT yet verified on device. | done (needs device test) |
| 2026-11-06 | `src/ar/flowTracker.js` (new), `src/ar/tracker.js`, `src/ar/pose.js`, `src/pages/Viewer.jsx`, `src/styles.css` | AR tracking accuracy: (1) hybrid tracking — ORB acquires, then pyramidal KLT optical flow follows sub-pixel corners frame-to-frame (forward-backward check, RANSAC + least-squares H, point top-up); ORB re-runs every 12 ticks in the ROI and reseeds flow if drift > max(5px, 2% quad edge); auto-falls back to detection-only if the OpenCV build lacks `calcOpticalFlowPyrLK`. Seeds use `goodFeaturesToTrack` if exported, else Harris-scored ORB keypoints (+`cornerSubPix` if present). (2) Frame-locked display: each tracked frame is drawn to `canvas.viewer-camera-frame` over the `<video>`, and the GL scene is rendered *after* tracking, so model and background come from the same frame (no sliding during motion). (3) One tick per new camera frame via `requestVideoFrameCallback` (28ms throttle fallback). (4) `grabGray()` + canvas sources in `extractFrame`. (5) Lighter One Euro preset for flow corners. Build + lint pass; NOT yet verified on device; Node test harness for flow at `%TEMP%\cvcheck\flowtest.mjs`. | done (needs device test) |
| 2026-11-06 | `ar-studio-frontend/src/ar/pose.js`, `src/pages/Viewer.jsx` | AR model stability: (1) replaced freeze/creep `smoothCorners` + render-loop pose deadband (stick-then-jump motion, model lagging/sliding off marker) with a One Euro filter on tracked corners (`filterCorners`) and direct anchor pose application; (2) camera intrinsics now from a 63° long-edge FOV (`verticalFovForFrame`) used by both pose solve and THREE camera — fixed 50° vertical made portrait frames ~1.4× too telephoto, amplifying tilt jitter; (3) symmetric R1/R2 orthonormalization instead of Gram-Schmidt. Verified numerically (exact pose recovery; ±2px corner noise → ~0.6px). | done |
| 2026-10-27 | `ar-studio-frontend/src/ar/sceneTransform.js` | Fix 3D model orientation/rotation in AR tracker (Viewer): changed `attachContentToTargetAnchor` pitch from `+Math.PI / 2` to `-Math.PI / 2` around X. Because tracker pose has +Z away from camera into the target plane, `-Math.PI / 2` maps editor world axes (+X right, +Y normal up out of card, +Z down the card) 1-to-1 onto the tracker anchor space, resolving the 180° upside-down/opposite pitch where models pointed into the card rather than upright as shown in the studio editor. | done |
| 2026-10-27 | `ar-studio-frontend/src/pages/Viewer.jsx`, `src/ar/animation.js`, `src/styles.css` | Fix 3D model animation in AR tracker (Viewer): (1) set animation controller default loop mode to `'repeat'` so models animate continuously in AR rather than playing once and freezing; (2) tie animation playback and ticking directly to target tracking visibility so animations do not run down their duration in the dark while camera is scanning; (3) automatically play/reset animation when target is acquired/re-acquired; (4) add floating `🎬 Animations` toggle button and connect `AnimationPanel` in AR Viewer so users can view/select clips, scrub, adjust speed, and toggle loop modes in real time. | done |
| 2026-10-27 | `ar-studio-frontend/src/pages/Viewer.jsx` | Fix 3D model position and orientation in AR Viewer: align `content` frame with `PreviewViewport` by rotating `-Math.PI / 2` around X, mapping `(pos[0], pos[2], -pos[1])` to maintain right/up/normal axes, and set model bounding-box base to `Y=0` (`-box2.min.y`) instead of centering and erroneously pitching `+Math.PI / 2`, resolving models rolling onto their sides or clipping behind the target. | done |
| 2026-10-27 | `ar-studio-frontend/src/pages/Viewer.jsx` | Fix 3D GLB model not displaying on target lock: removed erroneous dynamic scale multiplier that shrunk `content.scale` to 0.001/microscopic size; set `content.scale` to `(1, 1, 1)` to match normalized world coordinate space from `poseFromHomography`; boosted scene lighting (ambient 1.2, key 1.5, fill 0.8) so 3D models render brightly and visibly. | done |
| 2026-10-27 | `ar-studio-frontend/src/pages/Viewer.jsx`, `styles.css` | Added Target Found visual alert banner ("🎯 Target Found! Showing 3D Model"), subtle Web Audio chime (`playChime`), mobile haptic vibration (`navigator.vibrate`), and smooth spring scale reveal animation on the 3D GLB model so it springs into view right as the alert triggers. | done |
| 2026-10-27 | `ar-studio-frontend/src/ar/tracker.js`, `Viewer.jsx`, `styles.css` | Fix target image detection: reduced FAST corner threshold (12→7) and increased frame features (1200→2000) & target features (1800→2500) for low-contrast/screen targets; lowered RANSAC min inliers (10→7, locked 8→5) and inlier ratio (0.25→0.14); increased frame downscale resolution (640→800); relaxed minSpreadCells (2→1) for centered objects on white targets; extended LOSS_GRACE_MS to 1000ms; added live scanning guidance pill to HUD; added prominent viewer error overlay card for invalid/mistyped public IDs. | done |
| 2026-10-24 | `ar-studio-frontend/src/components/PreviewViewport.jsx` | X/Y/Z scale still imprecise: stock scale-mode raycast pickers are fat 0.6-long cones overlapping every axis on screen — clicking the X cube often hit the Y/Z cone or center box first, scaling the wrong axis. Added `sharpenPickers()`: scale pickers → 0.2 boxes exactly on the ±0.5 cubes, scale XYZ picker 0.3→0.16, translate cones slimmer (r0.2→0.08), visible scale cubes 0.08→0.12; sc center cube hidden (overlaps tc center in Universal). | done |
| 2026-10-24 | `ar-studio-frontend/src/components/UnityGizmoToolbar.jsx`, `styles.css` | Gizmo toolbar: Scale moved to 3rd slot; buttons/icons enlarged to medium (44px btn, 22px icons, 48px bar). | done |
| 2026-10-24 | `ar-studio-frontend/src/components/PreviewViewport.jsx` | Universal tool (Y) now shows Move+Rotate+**Scale** gizmos together (scale cubes sized 1.55× so they sit outside the rotate rings; arrows/rings unchanged); scaleControls properly detached in other modes and disposed on unmount. Removed forced uniform-scale block in `reportTransform` (+ dead `scaleStart`/`captureScaleStart`) — Scale tool X/Y/Z handles now scale per-axis natively (center cube still uniform). | done |
| 2026-10-24 | `ar-studio-frontend/src/components/RectGizmo.js` | Corner/edge scale is now **uniform across all 3 axes** (geometric mean of plane ratios) — stops the model from stretching/squashing when dragging rect handles. | done |
| 2026-10-23 | `ar-studio-frontend/src/pages/Viewer.jsx` | Fix dead corner smoothing: rebuild H each frame via exact 4-point `cv.findHomography` from target corners → smoothed corners, feed that to `poseFromHomography` (pose now benefits from the α=0.4 filter). Add `syncVideoSize` on `loadedmetadata` + `resize` (canvas/Camera aspect follow video; clear stale smoothed corners on size change); clean listeners in `stop()`; drop unused `trackerRef`. | done |
| 2026-10-23 | `ar-studio-frontend/src/components/PreviewViewport.jsx` | Stop full WebGL scene rebuild when parent re-creates `onAnimationController`: store callback in `onAnimationControllerRef` (same pattern as `onTransformChangeRef`); scene-mount effect deps → `[]`, rebuild effect deps → `[target, asset, aspect]`. | done |
| 2026-10-23 | `ar-studio-frontend/src/components/RectGizmo.js` | Corner/edge handles shared `outerMat` instead of per-handle `.clone()` — hover swap already reassigns material pointers; clones were unused waste. | done |
| 2026-10-23 | `ar-studio-frontend/src/components/PreviewViewport.jsx` | Tool fixes: (1) uniform-scale enforcement in `reportTransform` now gated on `transformControls.dragging` — `getMode()` survives `detach()`, so after using Scale once, Rect corner-drags and Rotate drags were being forced into uniform scale off a stale `scaleStart`; (2) Universal mode: mutual exclusion between the two TransformControls on `dragging-changed` (overlapping pickers let one press start translate+rotate simultaneously); (3) added `rectOrientation` to the gizmo-sync effect deps; (4) removed dead `num()` + unused `useMemo`. | done |
| 2026-10-23 | `ar-studio-frontend/src/components/RectGizmo.js` | Clear hover material on `onUp` — yellow highlight stuck on the last handle until next pointermove. | done |
| 2026-10-23 | `ar-studio-frontend/src/pages/Viewer.jsx` | Replace dead `loadedmetadata` listener (metadata already loaded after `await play()`) with the video element's `resize` event for orientation changes; call `syncVideoSize()` once at startup. | done |
| 2026-10-23 | `ar-studio-frontend/src/pages/ProjectDetail.jsx` | `TransformRow` no longer crashes on null/undefined transform fields (`value.toFixed(3)` throw — risk while migration 0004 unapplied): coerce via `Number(value) || 0`. | done |
| 2026-10-23 | `AR_cal/AR_cal/settings.py` | DB password env var was `config("2802", …)` (used the password *value* as the env-var *name*), so `POSTGRES_PASSWORD` was never read — restored to `config("POSTGRES_PASSWORD", default="6463")`. | done |
| 2026-10-21 | `ar-studio-frontend/src/ar/animation.js` (new) | Phase 2: `createAnimationController(gltf)` over `THREE.AnimationMixer` — clip list, play/pause/toggle/stop, loop modes (repeat/once/pingpong), speed 0.1–4×, `seek()`, `applySettings()` (Phase 3), frame-120ms-throttled `subscribe()` for UI, dt capped 0.25s, `dispose()`. | done |
| 2026-10-21 | `ar-studio-frontend/src/components/AnimationPanel.jsx` (new) | Phase 2: Blender/Unity-style transport UI — clip dropdown (if >1), ⏮/step/⏯/step/⏭/⏹, loop cycle ↻/1/⇄, speed select, collapsible timeline scrubber + `t/dur · frame n/N @24fps` readout; render-phase re-sync when controller changes. | done |
| 2026-10-21 | `ar-studio-frontend/src/pages/Viewer.jsx` | Phase 2: create controller on GLB load (autoplay unless `exp.animation` settings present — forward-compat for Phase 3), `clock.getDelta()` + `controller.update(dt)` in rAF loop, dispose in `stop()`, render `AnimationPanel` in viewer root. | done |
| 2026-10-21 | `ar-studio-frontend/src/components/PreviewViewport.jsx` | Phase 2: same controller/panel integration in studio preview; dispose + clear panel on scene rebuild and unmount; `controller.update(dt)` in render loop. | done |
| 2026-10-21 | `ar-studio-frontend/src/styles.css` | Phase 2: added `.anim-panel` transport styles (bottom-center, safe-area, 40px touch targets, blurred dark bar); moved `.viewer-hud` from bottom-left to top-right so it doesn't collide with the panel. | done |
| 2026-10-21 | `ar-studio-frontend/index.html` | Phase 1: add `viewport-fit=cover` to viewport meta so `env(safe-area-inset-*)` works on notched phones. | done |
| 2026-10-21 | `ar-studio-frontend/src/styles.css` | Phase 1: `.viewer-root` → `100dvh` + `overflow:hidden` + `overscroll-behavior:none` (fixes page scrolling/extending past screen); added `html/body:has(.viewer-root)` and `body.viewer-mode` scroll-lock rules; safe-area insets on `.viewer-back`/`.viewer-hud`. | done |
| 2026-10-21 | `ar-studio-frontend/src/pages/Viewer.jsx` | Phase 1: toggle `body.viewer-mode` class on viewer mount/unmount as JS scroll-lock fallback for browsers without `:has()`. | done |
| 2026-10-21 | `ANALYSIS_NOTES.md` (created) | Initial project analysis notes + this change-log file for recording every subsequent edit and its purpose. | done |
