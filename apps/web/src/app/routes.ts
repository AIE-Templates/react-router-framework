import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("features/demo/home.route.tsx"),
  // The static SPA shell contains root HydrateFallback markup. Match unknown URLs first so the
  // client hydrates that shell before reporting 404, instead of immediately hydrating an error
  // boundary against loading markup.
  route("*", "features/main/not-found.route.tsx"),
] satisfies RouteConfig;
