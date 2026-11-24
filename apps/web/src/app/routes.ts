import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  layout("features/demo/demo.layout.tsx", [
    index("features/demo/home.route.tsx"),
    route("deals", "features/demo/deals.route.tsx"),
    route("reports/sales", "features/demo/sales-report.route.tsx"),
  ]),
  route("settings", "features/demo/settings.route.tsx"),
  route("chat", "features/demo/chat.route.tsx"),
  // A static SPA shell contains root HydrateFallback markup. Match unknown URLs first so the
  // client hydrates that shell before reporting 404, instead of immediately hydrating an error
  // boundary against loading markup. SSR keeps the router's native HTTP 404 response.
  ...(process.env.SSR === "false" ? [route("*", "features/main/not-found.route.tsx")] : []),
] satisfies RouteConfig;
