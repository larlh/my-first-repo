# services/avatar-engine — local neural avatar engine

Placeholder created by the architecture phase. **Not implemented yet.** This directory will hold
the Python service required by the master prompt (§2b): photorealistic avatars with open-source
models and freely downloadable weights, running on the user's machine (CPU, GPU if present),
with no paid service.

What the rest of the system already expects from it (frozen contracts):

- **HTTP contract**: `packages/shared/src/avatar-engine.ts` (zod schemas + endpoint list):
  `GET /health`, `POST /v1/portraits/generate`, `POST /v1/portraits/prepare`,
  `POST /v1/animations`, `GET|DELETE /v1/jobs/:jobId`. Files are exchanged **by path** inside
  `AVATAR_ENGINE_WORK_DIR`; long operations are polled jobs with `progress` and `etaSec`.
- **Clients**: the `local-neural` providers in `packages/providers/src/{lipsync,portrait}`
  (currently stubs that report the engine as unavailable).
- **Entry point**: `services/avatar-engine/run.sh` (started by `pnpm avatar-engine`), listening
  on `AVATAR_ENGINE_URL` (default `http://127.0.0.1:8090`, loopback only).
- **Weights**: never committed. A download script fetches them with checksums into
  `AVATAR_ENGINE_MODELS_DIR`. Every model is recorded in `docs/MODELS.md` (origin, size,
  licence, commercial use).
- **Docker**: a `Dockerfile` here is used by the `avatar-engine` service (profile `neural`) of
  `docker-compose.yml`.
