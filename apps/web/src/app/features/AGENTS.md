# Features

Keep each business capability in its own feature. Register route modules only in ~/routes.ts; name pages <page>.route.tsx and layout routes <name>.layout.tsx. Keep feature-specific components, hooks, types and tests here; move reusable infrastructure outside features. Features do not import one another. SSR routes may export server loaders and actions. For a static SPA build, use clientLoader/clientAction in page routes and keep HydrateFallback at the root.
