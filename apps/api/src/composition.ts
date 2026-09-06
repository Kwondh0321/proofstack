/**
 * Supported composition boundary for embedding the API in tests and operator-owned runtimes.
 *
 * Importing this module never starts a listener. Callers must provide a validated configuration,
 * explicitly listen on an address, and close the returned Fastify instance themselves.
 */
export { type AppDependencies, createApp } from "./app.js";
export type { ApiConfig } from "./config.js";
export type {
  ReleaseCandidateRevisionAuthority,
  ReleaseCandidateRevisionReference,
  ReleaseCandidateRuntimeAuthority,
  ReleaseCandidateRuntimeReference,
} from "./repository-release-candidate-source-resolver.js";
export {
  type LocalGitReleaseCandidateRevisionAuthorityOptions,
  type LocalGitRepositoryRegistration,
  LocalGitReleaseCandidateRevisionAuthority,
  type StaticModelDeclarationRegistration,
  type StaticReleaseCandidateRuntimeAuthorityOptions,
  type StaticRuntimeAdapterRegistration,
  StaticReleaseCandidateRuntimeAuthority,
} from "./release-candidate-authorities.js";
