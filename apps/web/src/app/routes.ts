import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  // A static SPA shell contains root HydrateFallback markup. Match unknown URLs first so the
  // client hydrates that shell before reporting 404, instead of immediately hydrating an error
  // boundary against loading markup. SSR keeps the router's native HTTP 404 response.
  ...(process.env.SSR === "false" ? [route("*", "routes/not-found.tsx")] : []),
] satisfies RouteConfig;
