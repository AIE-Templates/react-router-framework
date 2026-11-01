# ADR 0009: Organize features and preserve infrastructure boundaries

Status: Accepted

The template must keep business examples disposable while allowing Core, UI-library and host layers to evolve independently through merges. A separate route directory would scatter each feature's implementation; a feature-local route module plus one routes.ts mapping preserves ownership without coupling URLs to the filesystem layout.

We therefore group routes, UI, state and tests by feature, while reusable infrastructure remains outside features. Appearance controls are shared UI in components; environment state is a domain in managers/environment, but its runtime remains owned directly by AppRoot. Moving files does not change lifecycle ownership or introduce host protocols into Core. A small renderWithProviders helper reduces ordinary UI-test setup while specialized lifecycle tests keep direct control.

Core semantic CSS variables remain the authority for appearance. Component modules and global project styles share the components layer; Tailwind utilities can still override them. Window safety CSS stays inline and unlayered because its pre-bootstrap fallback is a runtime requirement. A temporary app.css bridge lets downstream layers move their own content without converting every merge into a delete/modify conflict.

APP_ID is shared between consumers, with storage/cookie names derived by helpers. CSS uses stable application and feature namespaces independently of deployment identity. Source guards catch invalid definitions and media breakpoints without attempting to lint the entire architectural dependency graph. Explicit, reasoned inline exceptions keep third-party integrations possible without weakening the general convention.

Contracts are specified in [Application source structure](../specs/structure.spec.md). The migration does not introduce a Core request client, a generic service registry, or pre-created empty feature subdirectories.
