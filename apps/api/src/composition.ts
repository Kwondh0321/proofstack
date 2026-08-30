/**
 * Supported composition boundary for embedding the API in tests and operator-owned runtimes.
 *
 * Importing this module never starts a listener. Callers must provide a validated configuration,
 * explicitly listen on an address, and close the returned Fastify instance themselves.
 */
export { createApp, type AppDependencies } from "./app.js";
export type { ApiConfig } from "./config.js";
