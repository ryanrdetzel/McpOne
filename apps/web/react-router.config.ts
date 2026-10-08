import type { Config } from "@react-router/dev/config";

/**
 * SPA mode (0.7.0): the build emits static assets + index.html only, served by
 * apps/api from the same origin. No SSR process to own, no second service.
 */
export default { ssr: false } satisfies Config;
