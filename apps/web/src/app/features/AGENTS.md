# Features

Keep each business capability in its own feature. Register route modules only in ~/routes.ts; name pages <page>.route.tsx and layout routes <name>.layout.tsx. Keep feature-specific components, hooks, types and tests here; move reusable infrastructure outside features. Features do not import one another. Core/static page routes use clientLoader/clientAction, not server exports or non-root HydrateFallback.
