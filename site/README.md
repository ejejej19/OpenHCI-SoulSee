# OpenHCI Production Site

Cloudflare Worker/static site for `https://openhci.cechung.com`.

## Local Setup

```bash
npm install
npm run dev
```

Static pages under `public/` can be inspected without AI API secrets. API routes need local or deployed secrets.

## Routes

- `/` and other static paths are served from `public/`.
- `/ghost` is the capture-time AI Ghost camera and guidance page.
- `/ghost-edit` is the separate local, non-destructive post-production page.
- `/api/ghost` enforces a global daily generation budget, then proxies image/model generation through Vertex, Gemini API key fallback, or the configured Vertex proxy. When the Vertex-side upstream returns 429/5xx or fails to connect and `OPENAI_API_KEY` is set, the Worker transparently retries against OpenAI (`gpt-image-1` for image generation, `gpt-5-mini` for text; override with `OPENAI_IMAGE_MODEL` / `OPENAI_TEXT_MODEL`), translating the request and response so the frontend still speaks the Gemini format. The `x-openhci-upstream` response header reports which path served the call. On staging only, the `x-openhci-force-fallback: 1` request header forces the fallback for testing.
- `/api/suggest` proxies Anthropic Messages API requests.
- `/api/cuts-backups*` stores and reads explicit `/cuts` session backups through a private R2 binding. Access uses a 256-bit capability kept in the URL fragment and sent to the API as a bearer token; the raw capability is never used as an R2 key.
- `/cuts-backup` displays a capability-owned backup with every captured photo, AI proposal, per-shot prompt and proposal text, final PNG, and framed Live Photo GIF.

## Frontend And Backend

This project deploys as one full-stack Cloudflare Worker:

- `public/` contains the browser UI and static assets.
- `src/index.js` is the backend entry point for API routes and asset delivery.
- `wrangler.jsonc` configures production and staging bindings, routes, and non-secret variables.
- Cloudflare secrets are configured separately for each environment.

The accepted design for authenticated, user-owned capture history is documented
in [the Ghost history backend ADR](docs/architecture/user-history-backend.md).
It uses D1 for owned metadata and private R2 objects for saved images; the
bindings are intentionally deferred until isolated staging and production
resources are provisioned.

The `/cuts` cloud-backup flow is intentionally separate from that account-owned
history design. It does not require login or D1: pressing `雲端備份全部檔案`
creates a private R2 object group and returns an unguessable capability link/QR.
Anyone holding that link can read the complete backup. The current version has
no user-facing delete route; R2 remains private and every asset read is resolved
through the stored manifest.

The production Worker uses a SQLite-backed Durable Object to enforce one global
budget of 10,000 `/api/ghost` attempts per Taipei calendar day. The counter is
reserved before calling Vertex and returns HTTP `429` after the budget is used.
Production and staging use separate Durable Object namespaces.

The Ghost guidance path runs locally in the browser. It combines throttled
MediaPipe pose inference, an uncalibrated pose-landmark layout vector, a
confidence-gated horizon heuristic, and optional device-orientation input. The
layout vector separates subject/head center, width, height, frame share,
headroom, available footroom, and edge clearance; unavailable evidence stays
out of the score. It is not presented as a segmentation mask or physical
distance measurement. The AI look sync estimates brightness,
contrast, saturation, and warm/cool differences, then applies an editable
recipe to the editor preview and saved output. Camera frames, landmarks, and
sensor readings are not sent to the Cloudflare Worker by these measurement paths.

The shutter always saves an unfiltered original JPEG Blob to IndexedDB together
with the optional AI Ghost reference, confirmed intent, target-look statistics,
and capture receipt. Image bytes never enter `localStorage` or the research log.
The separate `/ghost-edit` route reloads that local record, applies every
filter/effect/slider recipe from the original pixels, and can compare the edited
view with the original or AI reference. Editing does not call the generation API.

Live corrections pass through a single-hint controller. A correction needs at
least 400 ms of stable evidence and sufficient confidence before it appears;
each message states both the action and observable reason. The user can skip a
hint for five seconds, pause/resume hints, or close guidance entirely. Shown,
resolved, skipped, and pause/resume events are kept in the local research log.

Before Ghost generation, the free-form preference is expanded into an editable
Intent Profile covering subject, relationship, pose, composition, camera angle,
subject scale, background, color, and mood. The user confirms up to three
important dimensions; both the original prompt and confirmed profile are kept
in the local research log and sent as explicit generation instructions.

Ghost generation then separates the profile into capture-time direction and a
post-production look. Pose, placement, scale, composition, camera position,
perspective, focus, and plausible depth of field must be solved before the
shutter. Color temperature, palette, contrast, saturation, highlights, shadows,
filters, effects, and non-geometric retouching remain a reversible look for the
later editor. The prompt preserves identity, clothing, location, background
structure, and real-world plausibility. Successful generations log the prompt
policy version without storing the generated image.

The post-capture intent receipt is deliberately scoped to observable evidence:
pose, subject placement, composition, and look. It reports measurement coverage
and asks the user for the final semantic judgment instead of claiming that a
visual score proves the original motivation was preserved.

## Required Secrets

Do not commit real values. For local development, copy `.dev.vars.example` to `.dev.vars` and fill only what you need.

```bash
cp .dev.vars.example .dev.vars
```

Possible secrets:

- `VERTEX_PROXY_SHARED_SECRET`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY_ID`
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY` (optional — enables the OpenAI fallback below)

Non-secret deployment variables such as project ID, location, model, proxy URL, and route are currently configured in `wrangler.jsonc`.

## Continuous Deployment

The existing Cloudflare Worker `openhci` is connected to this repository with
Workers Builds. A merge to `main` deploys from the `site/` root directory with
`npm run deploy`; non-production branches build preview versions without
replacing the live deployment.

Runtime secrets stay in Cloudflare and are not copied into GitHub.

### Staging

The separate Worker `openhci-staging` deploys the `develop` branch to
`https://staging.openhci.cechung.com` with `npm run deploy:staging`.

Use this promotion flow:

1. Branch from `develop` as `feature/<issue>-<scope>`.
2. Open a PR back to `develop` and verify the staging deployment.
3. Open a release PR from `develop` to `main` after staging approval.
4. Merge to `main` to deploy production.

Cloudflare secrets are environment-specific. Configure the required AI secrets
on `openhci-staging`; never place their values in GitHub or `wrangler.jsonc`.

## Manual Deployment

```bash
npm run deploy
```

Use `npm run dry-run` before deploying if you only want to validate the Worker bundle.
Use `npm run dry-run:staging` to validate the staging environment.

## Collaboration Notes

- Create an issue before changing routes, prompts, deployment config, or public prototype copy.
- Include screenshots or a local route in the PR evidence section.
- If AI-generated code is used, document who verified the behavior and what command or manual path was checked.
