import { index, type RouteConfig, route } from "@react-router/dev/routes";

// /healthz belongs to the api — in SPA mode there is no web server to serve one.
export default [
  index("routes/home.tsx"),
  route("gateway", "routes/gateway.tsx"),
] satisfies RouteConfig;
