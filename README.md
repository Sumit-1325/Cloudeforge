# CloudForge

CloudForge is a self-service deployment platform: users register GitHub repos,
and the backend clones, builds a Docker image, and runs it as Docker
containers on the same machine, exposing the app at `http://<host>:<port>`.
No Kubernetes cluster is needed — only Docker.

## Repository layout

- `Backend/` — Express + Mongoose API (`npm run dev` in `Backend/`)
- `frontend/` — React + Vite UI (`npm run dev` in `frontend/`, http://localhost:3000)

## Backend quickstart

```bash
cd Backend
cp .env.example .env   # then fill in MONGO_URI / JWT_SECRET
npm install
npm run dev            # nodemon -> http://localhost:5000
```

## Why `nodemon.json` exists — read before adding transient directories

`npm run dev` runs the server under **nodemon**, which by default watches
`**/*.*` under the project root and restarts on every file change.

The deployment pipeline writes cloned repositories into `Backend/workspace/`
during `repo.service.cloneRepo()`. Without the ignore rule in `nodemon.json`,
nodemon detects those clone writes and **restarts the server mid-clone**,
killing the `git` process and leaving a half-cloned folder (`.git` only, no
checked-out files) with no thrown error to catch.

Rules for future changes:

- **Any directory the backend writes to at runtime must be added to
  `nodemon.json` `ignore`.** `workspace/*` and `workspace/**` are listed there
  for exactly this reason.
- If you add a build-temp dir, cache dir, upload dir, or similar, add it to
  `nodemon.json` (and `.gitignore`) too — otherwise nodemon will restart the
  server mid-operation and the resulting bugs are very hard to trace.
- The backend currently writes only `workspace/` at runtime; nothing else
  needs ignoring.

## API

All routes under `/api` are JSON; send `Content-Type: application/json` with a
properly quoted body (bare `{name:...}` will be rejected with
`400 {"error":"Invalid JSON in request body"}`).

- `POST /api/auth/register`, `POST /api/auth/login` — get a JWT
- `POST /api/projects`, `GET /api/projects` — create/list repos (auth)
- `POST /api/deployments` — start a deploy (202, runs async)
- `GET /api/deployments/:id` — poll status (`pending` → `cloning` → `building`
  → `pushing` (only if a registry is configured) → `deploying` → `running`,
  or `failed`)
- `GET /api/deployments/:id/logs` — container logs (409 until running)
- `POST /api/deployments/:id/scale` — `{ replicas }` (1–10)
- `POST /api/deployments/:id/restart` — restart all containers
- `DELETE /api/deployments/:id` — remove the containers

## How deployments run (Docker only)

- The pipeline clones the repo, detects the project type (`package.json` →
  Node, `requirements.txt` → Python), and generates a Dockerfile from
  `src/templates/dockerfiles/` if the repo has none.
- Each project+environment gets a group of containers named
  `cf-<project>-<environment>-1`, `-2`, ... labelled
  `cloudforge.app=cf-<project>-<environment>` (see
  `src/services/docker.service.js`).
- Replica N (0-based) is published on host port `port + N`, because two
  containers cannot share one host port. The deployment URL points at the
  first replica: `http://<PUBLIC_HOST>:<port>`.
- CPU/memory are applied as `docker run --cpus` / `--memory` limits, and
  `PORT=<port>` is passed to the container.
- Redeploying the same project+environment replaces its containers and marks
  the previous deployment `stopped`.
- Before starting, the pipeline checks every host port it needs is free; after
  starting, it verifies the containers are still running, so an app that
  crashes on boot fails the deployment with its last logs.

```bash
docker ps --filter label=cloudforge.app   # list all CloudForge containers
```

---

# Local Setup Guide (Windows)

Everything needed to run CloudForge from zero on a Windows machine.

## Required accounts

- **MongoDB Atlas** (free tier) — or a local MongoDB install. Provides the
  connection string for `MONGO_URI`.
- **GitHub** — to create the repositories you deploy (must be public).
- **Docker Hub** — *optional*. Only needed if you also want built images
  pushed to Docker Hub (set `DOCKER_REGISTRY_USERNAME` and run `docker login`).

## Required software

- **Node.js** (18+; developed on 22)
- **Git** — used to clone the repositories being deployed.
- **Docker Desktop** — includes the `docker` CLI + engine. On Windows it needs
  WSL 2: run `wsl --install` in an **admin** PowerShell, then restart.
  Kubernetes does **not** need to be enabled.

## .env variables

Copy `Backend/.env.example` to `Backend/.env` and fill in:

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | optional | API port (default `5000`) |
| `MONGO_URI` | **required** | MongoDB connection string (Atlas or local) |
| `JWT_SECRET` | **required** | Secret used to sign auth tokens |
| `JWT_EXPIRES_IN` | optional | Token lifetime (default `1d`) |
| `DOCKER_REGISTRY_USERNAME` | optional | Docker Hub username. If set, images are tagged `<username>/<image>:<tag>` and pushed after building; if empty, images stay local as `cloudforge/<image>:<tag>` |
| `PUBLIC_HOST` | optional | Host used in deployed app URLs (default `localhost`; use the server's IP/domain on a VPS) |

## Setup order

```bash
# 1. Start Docker Desktop and wait for "Engine running"
docker info

# 2. Backend
cd Backend
npm install
cp .env.example .env     # fill in MONGO_URI and JWT_SECRET
npm run dev              # -> http://localhost:5000

# 3. Frontend (second terminal)
cd frontend
npm install
npm run dev              # -> http://localhost:3000

# 4. (Optional) only if DOCKER_REGISTRY_USERNAME is set
docker login -u <your-docker-hub-username>   # use an access token as password
```

## Deploying an app

1. Register / log in at http://localhost:3000.
2. **New Project** — paste a public GitHub repo URL
   (`https://github.com/<owner>/<repo>`, no trailing `/` or `.git`).
3. **Create Deployment** — choose branch, environment, replicas, CPU, memory
   and the **port your app listens on**.
4. Watch the status reach `running`, then open the URL.

Example repos that deploy without a Dockerfile:

- https://github.com/Sumit-1325/cloudforge-sample-frontend — Node, port `8080`
- https://github.com/Sumit-1325/cloudforge-sample-python — Flask, port `8000`

## Faster builds and less disk space

Most of the deploy time on a slow connection is downloading base images and
uploading to Docker Hub — not the build itself.

1. **Skip Docker Hub** — leave `DOCKER_REGISTRY_USERNAME` empty in
   `Backend/.env`. Images stay local and the slow `pushing` step disappears.
2. **Pre-download the base images once** (later builds reuse them):
   ```bash
   docker pull node:20-alpine
   docker pull python:3.12-slim
   ```
3. **Add a `.dockerignore` to the apps you deploy** so `node_modules`, `.git`,
   build output, etc. are not sent into the build:
   ```
   node_modules
   .git
   .next
   dist
   __pycache__
   ```
4. **Keep repos small and use multi-stage Dockerfiles** for apps with a build
   step (e.g. Next.js with `output: "standalone"`) — this cut one test image
   from 926 MB to 306 MB.
5. **Give Docker more CPU/RAM** — Docker Desktop → Settings → Resources (on
   WSL 2, set `processors=` / `memory=` in `%UserProfile%\.wslconfig`, then
   `wsl --shutdown`).
6. **Do not enable Kubernetes in Docker Desktop** — CloudForge doesn't use it,
   and it takes ~2 GB of disk plus RAM.
7. **Free disk space now and then**:
   ```bash
   docker image prune -a      # remove images not used by any container
   docker builder prune       # clear the build cache
   ```

## Known gotchas

a) **nodemon watches `workspace/`** — `npm run dev` restarts on file changes,
   and the clone step writes into `Backend/workspace/`. Without the ignore
   rule in `nodemon.json`, a mid-clone restart kills git and leaves only a
   `.git` folder with no checked-out files. **`nodemon.json` already fixes
   this — do not remove it**, and add any new runtime-written directory to its
   `ignore` list.

b) **Pick a free port** — the app's port is published on this machine, so it
   must not be used by anything else (the CloudForge UI uses `3000`, the API
   `5000`). With N replicas, ports `port` … `port + N - 1` must all be free.
   The pipeline checks this and fails with "Port N is already in use on this
   machine by another process" instead of serving the wrong app.

c) **The app must listen on the deployment's port, on `0.0.0.0`** — CloudForge
   maps host `port` → container `port` and sets `PORT=<port>` in the container.
   An app bound to `127.0.0.1` inside the container is unreachable.

d) **Generated Dockerfiles are generic** — the Node template runs
   `npm install --omit=dev` + `npm start`; the Python template runs
   `pip install -r requirements.txt` + `python app.py`. Frameworks that need a
   build step (e.g. Next.js) need their own `Dockerfile` in the repo.

e) **Docker Hub pushes on a slow connection** — when a registry is configured,
   `docker push` is retried automatically (up to 4 attempts) because uploads
   can time out with `timeout awaiting response headers`. Auth errors
   (`insufficient_scope`, `denied`) are not retried: check the username in
   `.env` matches your Docker Hub account and that `docker login` succeeded.

## How to verify it's working

With the backend running, exercise the API end-to-end:

```bash
# 1. Register a user, capture the token
curl -X POST http://localhost:5000/api/auth/register -H "Content-Type: application/json" \
  -d "{\"name\":\"Dev\",\"email\":\"dev@example.com\",\"password\":\"testpass123\"}"
# -> {"token":"...","user":{...}}   (use this token below)

# 2. Create a project pointing at a small public repo
curl -X POST http://localhost:5000/api/projects -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Demo\",\"repository\":\"https://github.com/Sumit-1325/cloudforge-sample-frontend\"}"
# -> 201 {"_id":"...","name":"Demo",...}   (note the project _id)

# 3. Create a deployment
curl -X POST http://localhost:5000/api/deployments -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d "{\"projectId\":\"<PROJECT_ID>\",\"branch\":\"main\",\"replicas\":1,\"cpu\":\"250m\",\"memory\":\"256Mi\",\"port\":8080}"
# -> 202 {"deploymentId":"...","status":"pending"}   (pipeline runs in the background)

# 4. Poll status until "running" (or "failed" + errorMessage)
curl http://localhost:5000/api/deployments/<DEPLOYMENT_ID> -H "Authorization: Bearer <TOKEN>"
# -> status moves pending -> cloning -> building -> deploying -> running

# 5. Confirm the container is up and open the app
docker ps --filter label=cloudforge.app
# -> browse to the deployment's "url", e.g. http://localhost:8080
```

Or run the scripted end-to-end check (deploy, logs, scale to 3, restart,
delete) against the running backend:

```bash
cd Backend
node scripts/test-lifecycle.js
```

If step 4 ends in `failed`, the `errorMessage` field on the deployment says
why (bad repo URL, port in use, app crashed on start, push failure, etc.).
