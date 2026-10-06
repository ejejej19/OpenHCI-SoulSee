# User-owned Ghost history backend

- Status: accepted for issue #40
- Target branch: `develop`
- Decision owner: Peter Chung
- Implementation owner: Codex

## Decision summary

Ghost history will be durable and user-owned. An authenticated user can list,
view, export, and delete only their own records across devices.

- `/ghost` remains available without login.
- Uploading a capture requires an explicit `Save to history` action and login.
- `/ghost-history` and every `/api/history/*` route require login.
- D1 stores users, session metadata, asset references, and versioned events.
- A private R2 bucket stores original, Ghost, and edited image files.
- The Worker validates identity and D1 ownership before every read or mutation.
- Staging and production use separate identity applications, D1 databases, and
  R2 buckets.

The first implementation may use Cloudflare Access for a controlled research
pilot. The application keeps identity behind an adapter because Access accounts
are seat-based and may not be the right long-term choice for a public product.

## Context

The browser currently stores one latest capture in IndexedDB. The local record
can contain the unfiltered original JPEG, an optional Ghost image, intent and
look data, and the capture receipt. A separate localStorage research log retains
at most 200 events. Downloaded edited images are not written back into the app.

This is useful for a private prototype but it cannot support long-term review:
browser-data clearing, private browsing, or changing devices loses the record.
The new backend must make review durable without turning camera guidance into
continuous surveillance.

## Goals

1. Let each signed-in user review their own history across devices.
2. Preserve the original intent, AI direction, captured result, edit recipe,
   and user judgment needed for later reflection.
3. Keep photos private and require explicit consent before upload.
4. Make interrupted uploads and deletions idempotent and recoverable.
5. Keep the identity provider replaceable.
6. Keep staging research data completely separate from production data.

## Non-goals

- An administrator or research-team history browser.
- Public sharing, social feeds, or public image URLs.
- Continuous upload of camera previews.
- Storage of raw pose landmarks, raw gyroscope readings, or video streams.
- Proving that a visual score measures a user's semantic motivation.
- Migrating older browser-only records without a new, explicit save action.

## Identity and authorization

### Phase 1 authentication

For the controlled research pilot, Cloudflare Access protects
`/ghost-history*` and `/api/history*`. The capture route remains public. Access
can use email one-time PIN or a configured identity provider.

The Worker must still validate `Cf-Access-Jwt-Assertion` on every protected API
request. Validation includes the remote JWKS signature, expected issuer, and the
environment-specific application audience. It must not trust an email header or
an unverified JWT payload.

The application uses this provider-neutral identity result:

```text
AuthenticatedIdentity {
  provider: string
  subject: string
  email?: string
}
```

For Access, `provider` is `cloudflare-access` and `subject` is the verified JWT
`sub` claim. The email is profile data only. It is not an authorization key and
must not be used for automatic account linking.

### Internal user IDs

The first authenticated request resolves `(auth_provider, auth_subject)` to an
internal UUID in D1. Every history row uses that UUID as `user_id`.

This indirection is required because identity providers can change and Access
subjects can change when an account is removed and later re-added. Re-linking a
new provider identity to an existing user requires a separately verified account
recovery flow; matching the same email address is not enough.

### Ownership invariant

Every history query is scoped by both resource ID and authenticated `user_id`.
Knowing a session UUID or R2 key never grants access.

```sql
SELECT *
FROM history_sessions
WHERE id = ? AND user_id = ? AND status = 'ready';
```

Asset reads first join `history_assets` to an owned session in D1, then fetch the
private R2 object. The Worker never exposes a general `GET /r2/:key` route.

## Consent, retention, deletion, and export

### Consent

Pressing the camera shutter continues to save locally only. Nothing is uploaded
until the user chooses `Save to history` and confirms the current consent text.

The consent screen must state that:

- the unfiltered original image is uploaded;
- the AI Ghost and final edited image are uploaded when available and selected;
- intent, guidance, measurements, edit settings, and the user's own judgment are
  stored with the session;
- raw camera previews, landmarks, sensor streams, and video are not uploaded;
- the user can delete the session later.

The server stores a version such as `history-photo-v1`, not only a Boolean.
Changing what is collected requires a new consent version and UI confirmation.

### Retention

Ready sessions remain until the user deletes them or the project reaches a
published research-data sunset. A future production launch must publish that
sunset or a retention interval before collecting data.

Incomplete drafts are hidden from history and expire after 24 hours. A cleanup
job deletes their R2 objects and D1 rows. Operational logs follow the Worker log
retention configured in Cloudflare and must not include image bytes, prompts,
email addresses, JWTs, or raw request bodies.

### Deletion

`DELETE /api/history/sessions/:id` is idempotent:

1. Verify ownership and change the session from `ready` or `draft` to
   `deleting`.
2. Delete all R2 keys recorded for the session.
3. Delete the D1 session; foreign keys remove asset and event rows.
4. Return success if the session is already absent.

If object deletion fails, the row remains `deleting`, is hidden from reads, and
the same request or cleanup job can resume it. This avoids claiming deletion
while image objects remain.

### Export

Phase 1 export consists of:

- a versioned JSON manifest containing the user's session metadata and event
  records; and
- authenticated downloads for each original, Ghost, and edited image.

No permanent or public signed URLs are included. A ZIP export can be added later
without changing the stored schema.

## D1 data model

All timestamps are UTC ISO 8601 strings. IDs are generated with
`crypto.randomUUID()`. JSON columns contain versioned objects and are parsed at
the API boundary. Migrations enable foreign keys.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  auth_provider TEXT NOT NULL,
  auth_subject TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (auth_provider, auth_subject)
);

CREATE TABLE history_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'deleting')),
  captured_at TEXT NOT NULL,
  original_intent TEXT NOT NULL,
  intent_profile_json TEXT,
  target_look_json TEXT,
  shot_summary_json TEXT,
  capture_receipt_json TEXT,
  look_recipe_json TEXT,
  user_judgment_json TEXT,
  prompt_version TEXT,
  model_version TEXT,
  metric_version TEXT,
  consent_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX history_sessions_user_created_idx
  ON history_sessions(user_id, created_at DESC);

CREATE INDEX history_sessions_status_updated_idx
  ON history_sessions(status, updated_at);

CREATE TABLE history_assets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('original', 'ghost', 'edited')),
  r2_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  etag TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, kind)
);

CREATE INDEX history_assets_session_idx
  ON history_assets(session_id);

CREATE TABLE history_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES history_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX history_events_session_time_idx
  ON history_events(session_id, occurred_at, id);
```

The API ignores client-supplied `user_id`, status, R2 key, and server timestamps.
The Worker derives those values after authentication.

## Private R2 layout

Production and staging each use a private bucket. Objects are grouped for
operations, not authorization:

```text
users/<internal-user-id>/sessions/<session-id>/original.jpg
users/<internal-user-id>/sessions/<session-id>/ghost.png
users/<internal-user-id>/sessions/<session-id>/edited.jpg
```

The Worker accepts only `image/jpeg`, `image/png`, and `image/webp`, applies a
configurable maximum byte size, and streams request bodies directly into the R2
binding. SVG and arbitrary content types are rejected. D1 is updated with the
asset record only after the R2 put succeeds.

Asset responses are streamed from R2 with the stored content type and
`Cache-Control: private, no-store`. The browser receives no bucket credentials.

## Worker API lifecycle

All routes below are same-origin, authenticated, JSON unless noted, and return a
stable error object:

```json
{
  "error": {
    "code": "history_session_not_found",
    "message": "History session was not found."
  }
}
```

### 1. Resolve the current user

`GET /api/history/me`

Validates the identity and returns the internal user ID plus display-safe profile
data. The first request creates the D1 user row. The response must not expose the
provider subject.

### 2. Create or resume a draft

`POST /api/history/sessions`

The client supplies a `client_session_id` UUID, consent version, capture time,
and metadata. The server uses that UUID as the session ID after validation. A
repeat request from the same owner is idempotent; a collision owned by another
user returns `409` without revealing that owner.

The response reports required and already-uploaded asset kinds.

### 3. Stream each asset

`PUT /api/history/sessions/:id/assets/:kind`

The Worker verifies draft ownership, content type, and content length, then
streams the body to R2. Repeating the same kind replaces the owner's draft object
and upserts its D1 asset row. Assets cannot be modified after completion.

### 4. Complete the session

`POST /api/history/sessions/:id/complete`

The Worker verifies ownership, the current consent version, and the presence of
the required `original` asset. Ghost and edited assets are optional. It changes
the draft to `ready` and returns the detail representation. Repeated completion
is idempotent.

### 5. Review history

- `GET /api/history/sessions?cursor=<opaque>&limit=<n>` returns newest ready
  sessions for the current user only.
- `GET /api/history/sessions/:id` returns one owned ready session.
- `GET /api/history/sessions/:id/assets/:kind` checks D1 ownership and streams
  one private object.

Pagination uses `(created_at, id)` as the stable cursor. Limits are bounded by
the server.

### 6. Update reflection data

`PATCH /api/history/sessions/:id`

Allows only versioned `look_recipe` and `user_judgment` updates. Capture facts,
ownership, consent, and original intent are immutable after completion.

### 7. Delete or export

- `DELETE /api/history/sessions/:id` follows the deletion lifecycle above.
- `GET /api/history/export` returns the versioned metadata manifest.

State-changing requests require a same-origin `Origin` header in addition to a
valid identity. The Worker does not enable cross-origin history access.

## Offline, retry, and partial uploads

IndexedDB remains the local source during capture and an upload outbox after the
user consents.

1. The client creates one UUID before the first API request.
2. It creates/resumes a D1 draft with that UUID.
3. It uploads only missing assets and records local progress after each success.
4. It calls `complete` only after required assets are present.
5. It removes the outbox marker only after receiving a `ready` session.

Network loss never deletes the local capture. The UI shows `Not saved`,
`Uploading`, `Saved`, or `Retry needed`; it never labels a local-only record as
cloud history. Retrying the entire sequence is safe. Drafts do not appear in the
history list.

## Staging and production isolation

The same binding names are used in code, but each Wrangler environment points to
different resources:

| Purpose | Production | Staging |
| --- | --- | --- |
| Worker | `openhci` | `openhci-staging` |
| D1 binding | `HISTORY_DB` | `HISTORY_DB` |
| D1 database | production history DB | staging history DB |
| R2 binding | `HISTORY_ASSETS` | `HISTORY_ASSETS` |
| R2 bucket | production private bucket | staging private bucket |
| Access application | production paths | staging paths |
| Access audience | production AUD | staging AUD |

Database IDs, bucket names, team domain, and audience values are added to
`wrangler.jsonc` only after the resources exist. No placeholder IDs are
deployed. Staging data is disposable and must never be copied into production.

Local tests use Miniflare D1/R2 bindings and an injected fake auth adapter. A
fake-identity HTTP header must never be accepted by staging or production.

## Security and observability rules

- Use prepared D1 statements and validate all UUIDs, JSON shapes, content types,
  byte sizes, and pagination limits.
- Stream image upload and download bodies; do not convert images to base64 JSON.
- Keep R2 private and authorize via an owned D1 session before every read.
- Return `404` for resources not owned by the current user to avoid ID leaks.
- Do not log JWTs, provider subjects, email addresses, prompts, image data, or
  research-event payloads.
- Log opaque user/session IDs, action, duration, byte count, result, and stable
  error code as structured fields.
- Keep Access team domain and AUD environment-specific. They are configuration,
  not proof by themselves; JWT verification is mandatory.
- Generate server IDs with Web Crypto and await every D1/R2 operation.

## Failure and rollback behavior

- D1 failure before R2 upload leaves the local outbox untouched.
- R2 success followed by D1 asset-write failure is retried with the same object
  key; the aged-draft cleanup removes any unreferenced object under that session.
- Completion fails closed until the required asset record exists.
- An asset missing from R2 returns a stable `history_asset_missing` error and is
  reported for cleanup; no other user's asset is substituted.
- Deployment can disable new uploads with an environment flag while preserving
  authenticated read and delete access.
- Rolling back frontend upload code does not make the private API or bucket
  public. Existing records remain readable through the prior compatible API.

## Delivery sequence

Implementation is split into independently reviewable issues:

1. [#41 Backend foundation](https://github.com/petercechung/OpenHCI/issues/41):
   D1 migration, R2 bindings, auth adapter, owned session/asset API, cleanup
   behavior, and fake-binding tests. No capture UI.
2. [#42 Capture save and upload](https://github.com/petercechung/OpenHCI/issues/42):
   explicit consent, local outbox, idempotent upload, progress/retry states, and
   completion. No history gallery redesign.
3. [#43 History review UI](https://github.com/petercechung/OpenHCI/issues/43):
   `/ghost-history` list/detail, original/Ghost/edited comparison, reflection
   update, download/export, and delete confirmation.

Each issue targets `develop`, must pass automated checks, and must be verified on
the isolated staging Worker before promotion to `main`.

## Deployment inputs still required

The repository currently declares neither D1 nor R2 bindings. Account-level
resources could not be inspected from the non-interactive environment because a
Cloudflare API token is not available. Before backend deployment, the owner must
confirm or provision:

- production and staging D1 databases;
- production and staging private R2 buckets;
- production and staging Access applications and policies;
- the Access team domain and each application AUD;
- enough Access seats for the intended pilot; and
- the initial consent copy and research-data sunset.

## References

- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Cloudflare Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Cloudflare Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Cloudflare Access seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare R2 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
