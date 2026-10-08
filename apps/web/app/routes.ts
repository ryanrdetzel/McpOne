import { index, type RouteConfig } from "@react-router/dev/routes";

// /healthz belongs to the api — in SPA mode there is no web server to serve one.
export default [index("routes/home.tsx")] satisfies RouteConfig;
