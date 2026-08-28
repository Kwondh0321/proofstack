# Security policy

ProofStack handles agent telemetry that may describe prompts, tool calls, identities, and business
processes. Treat every deployment as a security-sensitive observability system.

## Supported versions

ProofStack is in its foundation phase and has no supported production release yet. Security fixes
are applied to the `main` branch until the first versioned release policy is published.

## Reporting a vulnerability

Do not disclose suspected vulnerabilities in a public issue, discussion, commit, or pull request.
Use the repository's **Security → Report a vulnerability** flow to create a private report:

<https://github.com/Kwondh0321/proofstack/security/advisories/new>

Include the affected component, reproduction steps, expected impact, and any suggested mitigation.
Remove real credentials, customer data, prompt contents, and other sensitive material from the
report. If GitHub's private reporting flow is unavailable, contact the maintainer through the
GitHub profile first and share only enough information to establish a private channel.

The project will acknowledge a usable report as soon as practical, validate its scope, coordinate
a fix and disclosure timeline, and credit the reporter when requested and appropriate. This is not
a service-level agreement while the project remains pre-release.

## Deployment warning

The development authenticator and in-memory repository are intentionally non-production
components. The API refuses to start with development authentication in production or on a
non-loopback listener, but operators remain responsible for network isolation, encrypted
transport, secret management, backups, and a production identity provider.

See [docs/security/threat-model.md](docs/security/threat-model.md) for the current trust boundaries
and open security gates.
