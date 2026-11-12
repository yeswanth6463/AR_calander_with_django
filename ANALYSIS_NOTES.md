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
| 2026-11-12 | `AR_cal/api/views_auth.py`, `ar-studio-frontend/src/pages/Viewer.jsx`, `ProjectDetail.jsx`, `styles.css` | Implemented AR Model Upload and Interactive 3D Object Manipulation: (1) Added project-level `available_models` and `project_id` to public experience response payload. (2) Added interactive model switching and real-time model upload (.glb/.gltf) directly from the AR Viewer modal overlay with cleanup & disposal of old geometries/materials/animations. (3) Added Model Switcher dropdown in ProjectDetail Inspector for experience model replacement without recreating projects. (4) Added mobile & desktop multi-mode interactive manipulation controls (Drag/Move, 3-axis Rotate X/Y/Z, Scale, Reset) with 2-finger touch gestures (pinch-to-scale, 2-finger twist rotation) and mouse wheel/pointer drag. Built & passed tests (11/11). | done |
| 2026-10-26 | `AR_cal/api/views_auth.py`, `ar-studio-frontend/src/ar/tracker.js`, `Viewer.jsx`, `tracker.test.js` | Implement sequential multi-target tracking under a single published link: backend queries and returns all project experiences in an `items` array with target image, 3D model, and transform; `ImageTracker` stores multiple target descriptors, extracts frame features once, evaluates candidate matches, and computes homography for the best-matching target; `Viewer.jsx` compiles all target images, instantiates individual 3D model containers under the tracking anchor, and selectively displays only the actively recognized target's 3D model while snapping poses without cross-space glide; added multi-target tracking unit test (11/11 tests pass). | done |
| 2026-10-26 | `ar-studio-frontend/src/pages/Viewer.jsx` | Remove the `AnimationPanel` controller bar overlay from the AR camera tracking viewer while preserving automatic 3D model animation playback via the animation controller. | done |
| 2026-10-26 | `ar-studio-frontend/src/ar/pose.js`, `tracker.js`, `Viewer.jsx`, `pose.test.js` | Fix model orientation, position, and tracking stability: resolve homography global sign ambiguity in pose decomposition so target always stays in front of camera (Z > 0); validate projected quadrilateral convexity and clockwise orientation in tracker to reject flipped/bowtie homographies; introduce dedicated modelOrientation group (rotating anchor frame into upright, front-facing model space without rotating tracking anchor); apply single-pass target physical width scaling; add exponential lerp/slerp pose smoothing to eliminate jitter and jumps. | done |
| 2026-10-23 | `ar-studio-frontend/src/ar/tracker.js` | Validate `findHomography()` output (3×3, single-channel 32F/64F, finite, non-singular) before `perspectiveTransform()`; explicit managed mask Mats; try/finally release of every native object; throttled warnings; graceful empty/invalid-H failure reasons. | done |
| 2026-10-23 | `ar-studio-frontend/src/ar/pose.js` | Fix row/column-major mismatch when multiplying `Kinv` by the row-major homography; rescale source axes to the target's physical width so translation is in scene units instead of target pixels (previously placed the anchor beyond the far plane). | done |
| 2026-10-23 | `ar-studio-frontend/src/pages/Viewer.jsx` | Catch `tracker.track()` / pose failures as lost frames while keeping rAF + `renderer.render()` alive; de-duplicate track-state updates; pass target pixel/physical width to pose; scale the content offset by physical width and use the target-local +Y-down sign so the anchor lands on the target center; rotate content 180° about X so a Y-up GLB is upright; clear the video stream in cleanup. | done |
| 2026-10-23 | `ar-studio-frontend/src/ar/tracker.test.js`, `pose.test.js` (new), `package.json` | Add `node:test` regressions for empty/invalid H, throwing `perspectiveTransform`/`findHomography`, valid H, and pose layout/distance; add `npm test`. | done |
| 2026-10-21 | `ar-studio-frontend/src/ar/animation.js` (new) | Phase 2: `createAnimationController(gltf)` over `THREE.AnimationMixer` — clip list, play/pause/toggle/stop, loop modes (repeat/once/pingpong), speed 0.1–4×, `seek()`, `applySettings()` (Phase 3), frame-120ms-throttled `subscribe()` for UI, dt capped 0.25s, `dispose()`. | done |
| 2026-10-21 | `ar-studio-frontend/src/components/AnimationPanel.jsx` (new) | Phase 2: Blender/Unity-style transport UI — clip dropdown (if >1), ⏮/step/⏯/step/⏭/⏹, loop cycle ↻/1/⇄, speed select, collapsible timeline scrubber + `t/dur · frame n/N @24fps` readout; render-phase re-sync when controller changes. | done |
| 2026-10-21 | `ar-studio-frontend/src/pages/Viewer.jsx` | Phase 2: create controller on GLB load (autoplay unless `exp.animation` settings present — forward-compat for Phase 3), `clock.getDelta()` + `controller.update(dt)` in rAF loop, dispose in `stop()`, render `AnimationPanel` in viewer root. | done |
| 2026-10-21 | `ar-studio-frontend/src/components/PreviewViewport.jsx` | Phase 2: same controller/panel integration in studio preview; dispose + clear panel on scene rebuild and unmount; `controller.update(dt)` in render loop. | done |
| 2026-10-21 | `ar-studio-frontend/src/styles.css` | Phase 2: added `.anim-panel` transport styles (bottom-center, safe-area, 40px touch targets, blurred dark bar); moved `.viewer-hud` from bottom-left to top-right so it doesn't collide with the panel. | done |
| 2026-10-21 | `ar-studio-frontend/index.html` | Phase 1: add `viewport-fit=cover` to viewport meta so `env(safe-area-inset-*)` works on notched phones. | done |
| 2026-10-21 | `ar-studio-frontend/src/styles.css` | Phase 1: `.viewer-root` → `100dvh` + `overflow:hidden` + `overscroll-behavior:none` (fixes page scrolling/extending past screen); added `html/body:has(.viewer-root)` and `body.viewer-mode` scroll-lock rules; safe-area insets on `.viewer-back`/`.viewer-hud`. | done |
| 2026-10-21 | `ar-studio-frontend/src/pages/Viewer.jsx` | Phase 1: toggle `body.viewer-mode` class on viewer mount/unmount as JS scroll-lock fallback for browsers without `:has()`. | done |
| 2026-10-21 | `ANALYSIS_NOTES.md` (created) | Initial project analysis notes + this change-log file for recording every subsequent edit and its purpose. | done |
