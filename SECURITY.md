# Security Policy

Stacks Shield is a privacy protocol handling value. We take security seriously and
appreciate responsible disclosure.

## Supported versions

| Version | Status | Supported |
|---|---|---|
| v1 (testnet) | active development | ✅ |
| mainnet | not yet released | — |

Stacks Shield is **testnet-only and has not been audited.** Do not use it to
protect assets of real value.

## Reporting a vulnerability

**Please do not open a public issue, PR, or discussion for a security bug.**

Instead, report privately through **GitHub's private vulnerability reporting**
(the repository's *Security → Report a vulnerability* tab), or contact the
maintainers directly if you have a private channel.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a proof-of-concept if possible).
- Affected component(s): contract, circuit, SDK, relayer, API, or frontend.
- Any suggested remediation.

We will acknowledge your report, work with you on a fix and disclosure timeline,
and credit you (if you wish) once a fix ships.

## Scope

In scope: the Clarity contracts, Noir circuits, the `@stacks-shield/sdk`, and the
relayer/API services in this repository.

Out of scope: third-party dependencies (report upstream), the external
[zkVerify](https://zkverify.io) network, testnet infrastructure, and issues that
require a compromised deployer key or physical/social-engineering access.

## What we care about most

- Proof-soundness or verification bypass (accepting an invalid operation).
- Double-spend / nullifier or replay bypass.
- Value-conservation or pool-accounting violations (paying out more than shielded).
- Privacy leaks that link a withdrawal to its deposit, or reveal amounts/owners.
- Malicious-token attacks against the SIP-10 pool.

For the protocol's threat model, guarantees, and trust assumptions, see
[`docs/security.md`](docs/security.md).
