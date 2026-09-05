# Code review — v1.3.x through v1.4.7

Two-axis review of `git diff b59f782...HEAD` (34 commits, merge-base with `main` through `da7e101`).
Reviewed 2026-09-02 against `docs/review-context.md`, `CONTEXT.md`, and `docs/adr/`.

- **Standards** — does the code follow this repo's documented standards?
- **Spec** — does the code do what the originating spec asked for?

The axes are reported separately on purpose: a change can pass one and fail the other, and merging
the findings lets one axis mask the other.

## Standards

### src/caddy-adapter.js

Compliant with review-context #4 (`srv_https`/`srv_http`, DELETE-then-PUT via `replaceMapValue`,
`srv0` touched only for one-time migration then deleted) and #2 (unpublish/upsert filter and
preserve unrelated routes rather than clobbering).

- **Provider-inspection gap** *(judgement call — ADR-0005 / standard #1)*: `configure()`/`config()`
  filter redirect routes out of the inspected resource list via `isRedirectRoute`, so a manually
  deleted or edited redirect route is invisible to adoption. Probably intentional — it is an
  implementation detail, not a managed resource — but it is provider state that is never inspected.
- **Data Clumps** *(judgement call)*: `buildManagedRoute(hostname, backendIp, backendPort, backendTls)`
  takes four positional primitives torn out of `request`, while its sibling `issuerFor(request)`
  takes the whole object. Inconsistent calling convention for the same data.

### src/cli.js

- **Duplicated Code** *(hard)*: the exposure re-publish loop is copy-pasted verbatim in
  `changeBaseDomain` (~319-334) and `handleCaddyCommand` (~389-401) — the same
  `publishManagedExposure` call with the same six-field options object. Should be one shared helper.
- **Duplicated Code, cross-file**: step-ca hostname construction `${hostname}.${baseLocalDomain}`
  exists both as `stepCaCaHost()` in `cli.js` and inline as `caHost` in `exposure.js`.
- **Readability** *(judgement call)*, in `uninstallEverything`:

  ```js
  filesystem.deletePath(
    path.startsWith(secretStorePath)
      ? secretStorePath
      : path === statePath
        ? joinPath(projectDir, ".nomina")
        : path
  );
  ```

  A nested ternary hiding what actually gets deleted, in the one function where the deletion
  targets most need to be obvious.

Compliant: `removeService` matches by `s.id` first (#10); `persistCaddyLiveConfig` is called after
publish, remove, domain-change and redirect-toggle (#9); nuclear uninstall requires explicit
confirm/`--yes` and only touches recorded vmids (ADR-0026).

### src/tui.js

Standard #10 satisfied — `promptExposureServiceName` returns `s.id`, and the picker renders before
the IP/port prompts in `edit-exposure`.

- **Dead code** *(judgement call)*: in the edit-exposure handler, the
  `else if (adapters.prompts?.select)` branch re-assigns `backendIp`/`backendPort` to the values
  they already hold. A no-op left from a refactor.

### src/exposure.js

- **Formatting defect**: `const { name, hostname, backendIp, backendPort } = options;  const dnsRef = ...`
  — two statements on one line with a double space, likely a bad-merge artifact.

DNS/backend wiring (standards #5, #6) correctly preserved.

### No violations found

`adapter-runtime.js`, `adoption.js`, `step-ca-adapter.js`, `ca-guide.js`, `config.js`.
`withHealthyRetry` extends the existing `withBoundedRetry` pattern (#8) rather than duplicating it.

## Spec

### The redirect route re-introduces the `protocol` matcher

`src/caddy-adapter.js:519`, `buildRedirectRoute`:

```js
match: [{ host: [hostname], protocol: "http://" }],
```

The file's own comment at line 226 says *"Caddy 2.11.x silently never matches the `protocol` request
matcher"*, and the migration path at line 305 actively does `delete matcher.protocol`.
`docs/review-context.md` item 4: *"`protocol` matchers do not work on the current Caddy build."*

The v1.4.4 fix correctly dropped the matcher for TLS routes in favour of the dual-server split, then
the new redirect route brought it straight back. On real Caddy 2.11.4 the `srv_http` redirect never
fires, so `nomina caddy redirect on` does not actually 308.

`test/http-redirect-wire.test.js:118` only asserts the payload contains this exact broken matcher
shape, so nothing catches it. The `srv_http` server is already :80-only, so the matcher is redundant
even if it worked.

### `caddy-internal-ca` now reports as untrusted

`issuerFor()` (`caddy-adapter.js:538`) special-cases only `caStrategy === "step-ca"`;
`caddy-internal-ca` falls through to `{ module: "internal" }` at line 548, and `tlsSummaryFor()` at
line 555 maps any `"internal"` issuer to `trusted: false`.

But `src/exposure.js:60-61` sets `trusted: true` for that strategy, and the pre-diff code did too.
So `healthCheckExposure` reports `caddy-internal-ca` exposures as untrusted, indistinguishable from
genuinely untrusted ones. `test/caddy-adapter-wire.test.js:344` checks only the publish payload and
never calls `healthCheckExposure` for this strategy.

### No findings

- Nuclear uninstall — matches spec item 4, including refusing when the Proxmox adapter is unavailable.
- `--backend-tls` threading and the TUI re-ask on edit — survives domain change at `cli.js:1334/1401`.
- DNS-to-proxy-IP vs Caddy-to-backend-IP separation — `exposure.js:47`.
- Traefik/VPN scope — only a 4-line test touched, correctly still fake adapters.

## Summary

| Axis | Findings | Worst |
| --- | --- | --- |
| Standards | 7 | Duplicated exposure re-publish loop across two `cli.js` functions |
| Spec | 2 | The redirect route's `protocol` matcher, which silently disables `nomina caddy redirect on` and re-opens the exact bug v1.4.4 fixed |
