# aigccat

A general-purpose 3D game asset platform — describe what you want in natural language, get a Unity / Godot-ready 3D asset (GLB + Asset Contract).

![license](https://img.shields.io/badge/license-Apache--2.0-blue)

Telegram community: https://t.me/aigccat · [中文](README.md) · [Deployment Guide](docs/DEPLOYMENT.md) · [Docs Index](docs/README.md) · [Sponsorship](docs/SPONSORSHIP.md)

---

## What it is

aigccat is a **self-hosted AI 3D asset pipeline**: generate models from text or images, with versioning, validation, post-processing, rigging/animation and engine delivery — all running on your own machine, with assets stored in your own MinIO.

It is not a "look, it makes a model" demo. It exists to solve the unglamorous problems of real game projects: every NPC ends up with the same face, a small tweak forces a full regeneration, materials turn magenta after export, a cleanup script deletes a published asset, API costs are invisible, and reviewers are asked to approve from a single image.

## Screenshots

### Workbench

11 tools, a 3D viewport with orientation controls, and an asset panel on the right; the six-step workflow indicator sits on top.

![Workbench](docs/screenshots/workbench.png)

A first run starts from a single sentence — or upload reference images directly:

![New draft](docs/screenshots/workbench-new.png)

### Tools

| Image creation: text + optional image, producing four views at once | Texture: AI / existing / tiling / hand-painted |
|---|---|
| ![Image creation](docs/screenshots/tool-image.png) | ![Texture](docs/screenshots/tool-texture.png) |

| Remesh: decimate / retopologise / quad | UV unwrap: smart / angular |
|---|---|
| ![Remesh](docs/screenshots/tool-remesh.png) | ![UV unwrap](docs/screenshots/tool-uv.png) |

Animation: 101 motion templates, applicable straight to the model

![Animation](docs/screenshots/tool-animation.png)

### Assets

| Asset library: categories, search, batch ops, recycle bin | Asset graph: five node levels, four layouts |
|---|---|
| ![Asset library](docs/screenshots/library.png) | ![Asset graph](docs/screenshots/canvas.png) |

Image inventory: each asset's four views kept as a separate group, originals downloadable

![Image inventory](docs/screenshots/images-four-views.png)

### Panels

| Properties: pipeline stages, asset info, references | History: version history and operation log |
|---|---|
| ![Properties](docs/screenshots/panel-properties.png) | ![History](docs/screenshots/panel-history.png) |

## Features

**Asset management**

- Auto-classification into 12 controlled categories; jobs are separate from assets
- Three version pointers: `latest` / `approved` / `published`, with a published lock and one-click rollback
- Append-only history tree — check out any past version; HEAD moves, nodes are never deleted
- Incremental spec editing with diffs; candidate batches and anchor selection

**Generation and post-processing**

- Model inputs: text / single image / multi-view / batch
- 10 post-processing operations: decimate, remesh, quad, split, UV, material, upscale, rig, animation, transform
- Rigging and animation: apply Studio motion templates, or local AI rigging (an AI writes Blender scripts, executed through an OpenCode container)

**Quality and traceability**

- GLB structural validation: bounding box, height ratio, topology stats
- QA multi-view render sets; side-by-side version comparison
- Cost ledger with budget circuit breaker
- Engine bundle packaging (GLB + Contract + outline + manifest)

**Interface**

- Workbench with 11 tools; infinite-canvas asset graph (5 node levels, 4 layouts)
- Asset library, image inventory, project archiving and a recycle bin
- Unified login for local / LAN / public access; admin console with accounts, security, model & creation settings, theme and audit log

**Delivery**

- Unity and Godot import adapters
- MCP channel (17 tools)

## Architecture

```
browser ──► gateway :8080   (the only exposed port; unified auth)
               │
               ▼
           web :8080        (Rust / axum, single static binary, not published to the host)
               │
               ├── MinIO    (single source of truth for assets)
               │
               └── host workers (optional, on demand)
                     ├─ :8788  Blender 5.2.1 execution layer
                     ├─ :8790  Studio subscription session runner
                     └─ :8791  OpenCode → Blender bridge
```

- **Backend**: Rust + axum. All routes are registered in `web/src/main.rs`; modules only provide handlers
- **Frontend**: framework-free, build-free vanilla HTML/JS/CSS with a locally vendored Three.js
- **Storage**: MinIO (S3-compatible). Object keys are path-shaped and map 1:1 onto a local filesystem
- **Workers**: Blender-related capabilities run on the host; containers only orchestrate

## First, our situation: we're looking for sponsors

To be blunt — **this project currently runs entirely on one personal computer.** No server, and **not a
single paid credit on any generation platform.**

As a result, only the Tripo subscription path has ever produced real models. Every other platform
(Meshy, Rodin, Hunyuan3D, TRELLIS 2, Hi3D) **has never had a single real call paid for**, and stays
listed as "not integrated". We have one hard rule: **if it hasn't run, we don't write "supported"** —
so credits aren't a nice-to-have for us, they're the difference between shipping a feature and not.

Any of these helps:

| What we need | Specifically | Used for |
|---|---|---|
| **API credits / keys** | official API credits for Meshy, Rodin (Hyper3D), Hunyuan3D, Hi3D | finishing and actually testing those integrations |
| **TRELLIS 2 run credits** | pay-per-run cloud credits (e.g. Replicate / fal.ai, ≈$0.82 per run) | it has no first-party SaaS, so we'd call it via cloud |
| **A server** | a small always-on box or VPS (**no GPU needed**) | **hosting an online preview environment** so people can try it without installing anything |
| **Subscriptions** | plans on the above platforms that include API credits | same as the first item |

Details, boundaries and our commitments: **[Sponsorship & Platform Integration](docs/SPONSORSHIP.md)**.
Say hi in the **[Telegram community](https://t.me/aigccat)** — even a few dozen generations or an idle
little server genuinely helps.

## Quick start

**Option A · single container (recommended, no build required)**

```bash
docker run -d --name aigccat -p 8080:8080 -v aigccat-data:/data \
  ghcr.io/rainnameless/aigccat:latest
```

Open `http://localhost:8080`. The initial admin password is printed once on first start:

```bash
docker logs aigccat | grep -A2 "initial account"
```

One container holds storage (MinIO), the backend, the auth gateway and the AI rigging executor.
**No local compile, no .env needed** — secrets and the admin account are generated on first start and
kept in the data volume. All state lives in `aigccat-data`, so backup and migration are a single volume copy.

> Both Apple Silicon and x86 images are published. Pin a version by replacing `:latest` with `:sha-xxxxxxx`.

**Option B · multi-container (development, or multi-user / public deployment)**

```bash
git clone https://github.com/RainNameless/aigccat.git && cd aigccat
cp .env.example .env          # set MINIO_ROOT_PASSWORD and your service keys
docker compose -p aigccat -f docker-compose.yml up -d --build
```

For host workers, public deployment and troubleshooting, see the **[Deployment Guide](docs/DEPLOYMENT.md)**.

## Not implemented / not verified (stated honestly)

- The Tripo **API** path exists but was **never verified end to end** — the account balance was 0. Everything actually produced came through the Studio web-subscription path
- Studio **free-prompt motion** and **arbitrary-body rigging** are not wired up (humanoid is tested; other body types are not guaranteed)
- **AI texturing** (Studio texture) failed upstream three times; the frontend entry is disabled
- Prompt-to-skeletal-animation and a real-device Unity adapter smoke test are unfinished

**Other generation platforms are not integrated at all**: Meshy, Rodin / Hyper3D, Hunyuan3D,
TRELLIS 2, Hi3D. The provider layer is built to be pluggable, but we have not been able to pay for a
single real call on any of them — and without real calls we don't write "supported".
We're looking for sponsors, see the section above.

## Known limitations

- Designed for **single-machine, single-user** self-hosting: concurrency is fixed at 1, accounts share one asset library, and there is **no tenant isolation**
- Paid upstream calls are **never retried automatically** (the upstream may already have billed); failures are reported as-is
- Anything involving AI generation requires you to supply and pay for the corresponding service quota
- Asset management depends on MinIO — no MinIO means no asset read/write

## Repository layout

```
web/src/        Rust backend (axum + MinIO)
web/static/     Frontend (index=workbench / library=asset library / admin=console)
scripts/        auth-server=auth gateway  blender=Blender execution layer
                studio-runner=Studio runner  opencode-runner=AI rigging
                deploy/cat-tunnel=public tunnel
docs/           Documentation (README.md is the index)
adapters/       Unity / Godot import adapters
mcp_server/     MCP server
```

See [`docs/README.md`](docs/README.md) for the documentation index.

## Third-party services

aigccat is a **self-hosted tool** and ships with no third-party quota:

- `scripts/studio-runner/` calls Studio through **your own logged-in web session** and requires your own active subscription. This project does not provide, top up, or bypass any paid quota
- Tripo and similar generation capabilities likewise require your own key and your own costs
- Make sure your usage complies with the terms of the respective services

Third-party component licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Sponsors

**None yet — you could be the first.**

This section will list supporters (or "a community member" if you prefer to stay anonymous) together
with whatever they funded.

What we're looking for: [API credits and platform subscriptions](docs/SPONSORSHIP.md)
(Meshy / Rodin / Hunyuan3D / TRELLIS 2 / Hi3D), plus **one small server to host an online preview
environment** (no GPU needed). Just say hi in the [Telegram community](https://t.me/aigccat).

## License

[Apache License 2.0](LICENSE)
