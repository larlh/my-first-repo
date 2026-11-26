# services/voice-engine — realistic local voice cloning (Spain Spanish)

Clones a person's voice — timbre included — on this machine, with **no paid service**:
[Chatterbox Multilingual](https://github.com/resemble-ai/chatterbox) by Resemble AI (MIT) with
its Spain-Spanish T3 finetune (`ResembleAI/Chatterbox-Multilingual-es-es`), which speaks with an
accent from Spain (the general multilingual T3 sounds Latin-American). The rest of Parlante talks
to it over a small loopback HTTP API; the only client is
`packages/providers/src/voice-clone/voice-engine.ts`.

| Endpoint                 | What it does                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `GET /health`            | state (loading / ready / error), device, engine + licence, defaults, measured real-time factor    |
| `POST /v1/voices`        | `{sampleWav, language, consentId}` → `{voiceId: "cbx_…", referenceSec}`: derives the conditionals |
| `GET /v1/voices/{id}`    | 200 when the engine holds the voice, 404 otherwise                                                |
| `DELETE /v1/voices/{id}` | deletes everything the engine keeps for that voice (idempotent)                                   |
| `POST /v1/speech`        | `{voiceId, text, language, speed?, pitch?}` → WAV (base64) + where each sentence sits + watermark |
| `POST /v1/watermark`     | `{audioWav}` → `{watermark, detected}`: Perth detector score of any WAV                           |

Defaults chosen by ear with the person whose voice was cloned (2026-11-26): `exaggeration=0.3`,
`cfg_weight=0.3`, `temperature=0.7` (`VOICE_ENGINE_EXAGGERATION`, `_CFG_WEIGHT`, `_TEMPERATURE`).

## Quick start

```bash
pnpm voice-engine                         # = bash services/voice-engine/run.sh  (http://127.0.0.1:8091)
bash services/voice-engine/run.sh --setup # install + download only
.venv/bin/python scripts/download_models.py --list    # files, sizes, licence, state
.venv/bin/python -m unittest discover -s tests        # fast tests (no model)
```

`run.sh` creates `services/voice-engine/.venv` (or reuses `VOICE_ENGINE_VENV`, a virtualenv that
already runs Chatterbox), installs `requirements.txt` when `scripts/check_env.py` says the
environment cannot run the engine, downloads the weights at pinned revisions with sha256
verification (≈3.3 GB, into the Hugging Face cache) and starts the server. The server itself never
goes online (`HF_HUB_OFFLINE=1`). With `VOICE_CLONE_PROVIDER=auto` (default) API and worker clone
Spanish voices here whenever the engine answers; otherwise they fall back to the basic voice profile.

## Privacy, consent and provenance

- Parlante only calls `POST /v1/voices` after a consent record was accepted (CONTRACTS, voice
  cloning); the engine stores the consent id next to the voice for audit.
- The engine keeps **only the conditionals** derived from the sample (speaker embedding, prompt
  tokens, decoder reference features) under `VOICE_ENGINE_DATA_DIR/voices/<cbx_id>/` — never the
  recording, which stays in Parlante's storage. Deleting the voice or revoking its consent calls
  `DELETE /v1/voices/{id}`; if the engine is down, the deletion fails visibly and can be retried.
- **Watermark, always.** Chatterbox marks every generated chunk with the Perth implicit
  watermark; the finished audio is checked with the Perth detector, marked again when the score is
  below 0.5, and refused when it still is. The engine does not start without the watermarker
  (`setuptools<81` is pinned because Perth needs `pkg_resources`). The Node client double-checks
  the score. Results are stamped `Chatterbox es-ES (local)` (premium quality, local) so the UI and
  `/v1` say who produced the audio.

## Measured on the reference machine

WSL2 Ubuntu 24.04, RTX 4060 Laptop 8 GB (driver 566.24), torch 2.6.0+cu124: model load 17 s,
≈3.7 GB of VRAM, registering a voice 3 s, speech about real time (6.2 s for 5.9 s of audio,
first call). On CPU it works but is several times slower than real time.

## Limits

- Spanish only (the T3 is the es-ES finetune). Other languages use the basic profile.
- Chatterbox gives no timings: words are estimated per sentence (`estimateSpeechTimeline`) over
  the span the engine reports for each chunk, which keeps subtitles and the 2D mouth aligned.
- With `cfg_weight=0.3` some sentences come out slow (it follows the pace of the reference).
- The `s3gen_v3` decoder of the es-es repository does not load in chatterbox-tts 0.1.7.

## Environment fixes (reference machine)

1. `setuptools<81` (see above).
2. `nodeenv==1.12.0`, `narwhals==2.29.0`, `nvidia-cublas-cu12==12.4.5.8` reinstalled with
   `--force-reinstall --no-deps` when their `RECORD` files are damaged (`run.sh` does it when
   `check_env.py` fails after installing).
3. torch and chatterbox are imported before huggingface_hub / safetensors.
