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
