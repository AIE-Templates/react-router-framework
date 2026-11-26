# React Router Framework Templates

Multi-branch starter repository for React Router Framework applications. Each template lives on its own long-lived branch; this `main` branch holds only repository documentation and branch-maintenance tooling and is never merged into template branches.

## Template Branches

| Branch | Runtime | UI | Platform | Capabilities |
| --- | --- | --- | --- | --- |
| `starter/base` | SSR (default) / SPA (`SSR=false`) | Minimal | Web | Workspace toolchain (Oxlint, Oxfmt, Vitest, TypeScript, Lefthook, commitlint), `react-router-serve` |
| `starter/static` | Static SPA (`ssr: false`) | Minimal | Web | Static SPA shell, optional prerender, Node static server, nginx container |
| `starter/fullstack` | SSR / SPA | Minimal | Web | Hono API & BFF (`@repo/server`), CSP nonces/hashes, structured logging, CSRF, graceful shutdown, Docker |
| `app/base/core` | SSR / SPA | Core CSS | Web | `@repo/shared`, `AppRoot`, environment runtime, application shells, fused header layouts, CRM and editor demos, visual preferences & prepaint script |
| `app/static/core` | Static SPA | Core CSS | Web | `starter/static` + `app/base/core` |
| `app/fullstack/core` | SSR / SPA | Core CSS | Web | `starter/fullstack` + `app/base/core` with host and CSP wiring for Core visual preferences |
| `app/base/mantine` | SSR / SPA | Mantine | Web | `app/base/core` + Mantine provider, CSS layers, Core visual theme adapter |
| `app/static/mantine` | Static SPA | Mantine | Web | `app/static/core` + `app/base/mantine` |
| `app/fullstack/mantine` | SSR / SPA | Mantine | Web | `app/fullstack/core` + `app/base/mantine` |
| `platform/electron/core` | Embedded Hono (SSR / SPA) | Core CSS | Electron | `app/fullstack/core` + Electron main/preload/utility host, `@repo/port-fetch`, `@repo/channel`, window chrome & visual IPC, packaging & release verification |
| `platform/electron/mantine` | Embedded Hono (SSR / SPA) | Mantine | Electron | `platform/electron/core` + `app/fullstack/mantine` |

## Starting a Project

Clone only the branch you need, then detach it from this repository:

```bash
git clone --branch <branch> --single-branch git@github.com:AIE-Templates/react-router-framework.git my-app
cd my-app
rm -rf .git && git init
```

Business projects take a one-time snapshot of a template branch and evolve independently; ongoing template syncing is not supported.

## Maintenance

- Architecture, layer boundaries, merge contract, and cascade CLI reference: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Branch graph definition: [`cascade/topology.json`](cascade/topology.json)

```bash
node --run test             # or: node --test cascade/*.test.ts
node --run audit:branches   # or: node cascade/audit.ts
node --run cascade:dry-run  # or: node cascade/cascade.ts --dry-run
node --run cascade          # or: node cascade/cascade.ts
```
