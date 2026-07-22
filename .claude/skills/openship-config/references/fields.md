# `openship.json` — full field reference

Every field is optional. Present fields override auto-detection; absent fields keep the detected
value. Validated by `openship config validate` (same parser the deploy uses).

## Build

| Field | Type | Notes |
|---|---|---|
| `framework` | enum | Stack slug (see list below). Overrides detection. |
| `packageManager` | enum | `npm` `yarn` `pnpm` `bun` `go` `cargo` `pip` `poetry` `pipenv` `uv` `bundler` `composer` `maven` `gradle` `dotnet` `mix` |
| `rootDirectory` | string | App dir relative to repo root (e.g. `./`, `apps/web`). |
| `installCommand` | string | Dependency install command. |
| `buildCommand` | string | Build command. |
| `startCommand` | string | Production start command. |
| `outputDirectory` | string | Build output dir (`dist`, `.next`, `build`, `out`, …). |
| `buildImage` | string | Build Docker image (e.g. `node:22`). |
| `productionPaths` | string[] | Paths shipped as the production artifact. |

**`framework` values:** `nextjs` `nuxt` `sveltekit` `remix` `astro` `vite` `angular` `gatsby`
`cra` `vue` `react` `express` `fastify` `hono` `nestjs` `koa` `adonis` `elysia` `go` `gin`
`fiber` `echo` `rust` `actix` `axum` `rocket` `python` `django` `flask` `fastapi` `rails`
`sinatra` `laravel` `symfony` `springboot` `quarkus` `kotlin` `dotnet` `blazor` `phoenix`
`node` `static` `docker` `docker-compose` `webmail`.

## Runtime

| Field | Type | Notes |
|---|---|---|
| `runtime` | `bare` \| `docker` | Runtime isolation for a single app. Services/docker projects are always `docker`. Seeds a new deploy's runtime. |
| `productionMode` | `host` \| `static` \| `standalone` | `static` ⇒ served as files, no server (sets `hasServer=false`). |
| `port` | integer 1–65535 | Server port. |

## Env

`env` is an object. A value is either a plain string, or `{ "value": string, "secret"?: boolean }`.
`secret: true` marks the variable for encryption at rest.

```json
"env": {
  "PUBLIC_URL": "https://app.acme.com",
  "API_KEY": { "value": "sk_live_…", "secret": true }
}
```

## Domains

`domains` is an array. Each entry is either a hostname string, or an object:

| Field | Type | Notes |
|---|---|---|
| `domain` | string | Hostname. Bare label = free subdomain; dotted = custom. |
| `port` | integer | Which port this hostname routes to. |
| `targetPath` | string | Path prefix on the target (default `/`). |
| `type` | `free` \| `custom` | Overrides the free/custom inference. |

## Routes

`routes` compiles to the reverse proxy at deploy.

| Field | Type | Notes |
|---|---|---|
| `rewrites` | `{ source, destination }[]` | Internal rewrites (e.g. SPA fallback). |
| `redirects` | `{ source, destination, permanent?, statusCode? }[]` | 3xx redirects. |
| `headers` | `{ source, headers: { key, value }[] }[]` | Response headers per path. |
| `cleanUrls` | boolean | Strip `.html`. |
| `trailingSlash` | boolean | Enforce/remove trailing slash. |

## Resources (cloud only)

`resources` is a named tier OR explicit values. Explicit values become the `custom` tier.

| Field | Type | Range |
|---|---|---|
| `tier` | `micro` \| `low` \| `medium` \| `high` | — |
| `cpuCores` | number | 0.25–4 |
| `memoryMb` | integer | 128–8192 |
| `diskMb` | integer | 64–204800 |

## Services (compose)

`services` is an array; declaring it makes the project a multi-service (Docker) project.

| Field | Type | Notes |
|---|---|---|
| `name` | string | **Required.** |
| `image` | string | Prebuilt image (e.g. `postgres:17`). |
| `build` | string | Build context path. |
| `dockerfile` | string | Dockerfile path. |
| `ports` | string[] | e.g. `["3000"]`, `["5432:5432"]`. |
| `volumes` | string[] | e.g. `["pgdata:/var/lib/postgresql/data"]`. |
| `dependsOn` | string[] | Other service names. |
| `env` | env object | Same shape as top-level `env`. |
| `command` | string | Override the container command. |
| `restart` | `no` \| `always` \| `on-failure` \| `unless-stopped` | Restart policy. |
| `exposed` | boolean | Publicly routed. |
| `exposedPort` | string | Which container port is exposed. |
| `domain` | string | Public hostname for this service. |
| `healthcheck` | object | `{ test, interval, timeout, retries, startPeriod, disable }`. |

## Monorepo

`monorepo` overrides detected sub-apps.

| Field | Type | Notes |
|---|---|---|
| `workspace.packageManager` | string | Root workspace package manager. |
| `workspace.prepareCommand` | string | Runs once at the repo root before per-app builds. |
| `apps[]` | array | Per-sub-app build overrides. |

Each `apps[]` entry (`name` + `rootDirectory` required) overrides the detected sub-app at that
`rootDirectory`. Supported overrides: `framework`, `packageManager`, `installCommand`,
`buildCommand`, `startCommand`, `outputDirectory`, `buildImage`, `port`. (Per-app `domain`/`env`
are set in the wizard, not here.)

## Not supported (do not add)

`sleepMode`, monorepo `sharedPaths`, and per-app `domain`/`env`/`exposed` are validated leniently
but **not applied** — leave them out.
