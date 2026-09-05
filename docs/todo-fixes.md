# TODO — fixes from the v1.3.x→v1.4.7 review

Actionable fix list derived from `docs/review-v1.4.7.md`. Reviewed range: `git diff b59f782...HEAD`
(34 commits, through `da7e101`). Line numbers verified against the working tree on 2026-09-02 — if
you edit files in a different order, re-grep before trusting them.

Read `docs/review-context.md` first. Its numbered "What to look for in review" list is the standard
these fixes are measured against; the item numbers are cited below as "review-context #N".

**Ground rules for whoever applies these:**

- Tests are `node --test` plus `tsc --noEmit`. Baseline is 233 passing. Run both after each fix.
- Do not refactor beyond the described change. Several of these live in code paths that took
  multiple live-hardware releases to get right (see review-context "How it evolved").
- Fixes 1 and 2 are behavioural bugs and change test expectations. Fixes 3-7 are cleanups and must
  not change behaviour or any test assertion.
- Verification on real hardware is called out where a unit test genuinely cannot prove the fix.

---

## Priority 1 — behavioural bugs

### FIX-1 — Redirect route never fires: remove the `protocol` matcher

- **File:** `src/caddy-adapter.js:513-528` (`buildRedirectRoute`)
- **Also touches:** `test/http-redirect-wire.test.js:118`
- **Severity:** High — `nomina caddy redirect on` silently does nothing on real Caddy.
- **Standard:** review-context #4 — *"`protocol` matchers do not work on the current Caddy build."*

**The problem.** The route builder re-introduces the exact matcher the v1.4.4 fix removed:

```js
function buildRedirectRoute(hostname) {
  return {
    "@id": `${hostname}${REDIRECT_SUFFIX}`,
    match: [{ host: [hostname], protocol: "http://" }],
    ...
```

This directly contradicts the file's own comment at line 226:

```js
// Caddy 2.11.x silently never matches the "protocol" request matcher, so
// scheme separation is done with two servers instead: srv_https (:443) holds
// the TLS routes, srv_http (:80) holds the 308 redirects.
```

and the migration path at line 305, which actively strips the matcher from legacy routes
(`delete matcher.protocol`). On Caddy 2.11.4 the matcher never matches, so the redirect route on
`srv_http` never fires and plain-HTTP requests fall through.

**The fix.** The matcher is not just broken, it is redundant: `srv_http` is bound to `:80` only, so
every request reaching it is already cleartext. Drop the `protocol` key:

```js
match: [{ host: [hostname] }],
```

**Also fix the stale comment** three lines above it, which currently documents the broken design:

```js
// The route matches only cleartext requests (protocol matcher) so it never
// shadows the TLS route; ...
```

Replace the parenthetical — scheme separation comes from the `:80`/`:443` server split, not from a
matcher. Keep the second half about `@id` and the suffix; that part is still true.

**Test change required.** `test/http-redirect-wire.test.js:118` currently pins the broken shape and
would fail:

```js
assert.deepEqual(redirectRoute.match, [{ host: ["dns.bunny.internal"], protocol: "http://" }]);
```

Change it to `[{ host: ["dns.bunny.internal"] }]`. Note this test only ever asserted the JSON payload
shape, which is why the regression went unnoticed — a payload assertion cannot tell you whether
Caddy matches the route.

**Real-hardware verification** (a wire test cannot prove this): with redirect on, `curl -sI
http://<hostname>` must return `308` with a `Location:` of `https://<hostname>/`. With redirect off,
the same request must NOT proxy in cleartext.

---

### FIX-2 — `caddy-internal-ca` exposures are reported as untrusted

- **File:** `src/caddy-adapter.js:538-556` (`issuerFor`, `tlsSummaryFor`)
- **Callers to thread context through:** `src/caddy-adapter.js:202` and `:581`,
  `src/exposure.js:163-170`, `src/adoption.js:345-347`
- **Severity:** Medium-High — health output lies; a working exposure is indistinguishable from a
  genuinely untrusted one.
- **Standard:** review-context #5 (verify the serializer).

**The problem.** `issuerFor()` special-cases only step-ca; `caddy-internal-ca` falls through to the
same generic branch as no-CA:

```js
function issuerFor(request) {
  if (request.caStrategy === "step-ca") { ... }
  return { module: "internal" };     // line 548 — caddy-internal-ca AND none land here
}

function tlsSummaryFor(issuer) {
  if (issuer?.module === "acme") { return { issuer: "acme", trusted: true, ... }; }
  return { issuer: "internal", trusted: false };   // line 555 — always false
}
```

But `src/exposure.js:60-61` explicitly declares that strategy trusted, and the pre-diff code agreed:

```js
tlsOptions = { mode: "caddy-internal-ca", issuer: "caddy-internal-ca", trusted: true };
```

So `healthCheckExposure` returns `tls: "untrusted"` for every `caddy-internal-ca` exposure.

**Why it is not a one-line fix.** `{ module: "internal" }` is the shape Caddy's API requires, so the
published payload cannot be changed to carry the distinction. `tlsSummaryFor` must receive the CA
strategy as separate context — and its two callers do not currently have it:

- `caddy-adapter.js:202`, inside `healthCheckExposure(request)` — `request` has no `caStrategy`,
  because `exposure.js:163-170` does not pass one.
- `caddy-adapter.js:581`, inside `toManagedResource(route, policies)` — no request in scope at all.

**Suggested approach.** Give `tlsSummaryFor` a second parameter and thread the strategy from the
call sites that know it:

```js
function tlsSummaryFor(issuer, caStrategy) {
  if (issuer?.module === "acme") {
    return { issuer: "acme", trusted: true, ...(issuer.ca ? { ca: issuer.ca } : {}) };
  }
  if (issuer?.module === "internal" && caStrategy === "caddy-internal-ca") {
    return { issuer: "caddy-internal-ca", trusted: true };
  }
  return { issuer: "internal", trusted: false };
}
```

Then add `caStrategy` to the proxy health-check request in `src/exposure.js:164-169` (the CA strategy
is already computed there as the `caStrategy` const at line 58) and pass it through at
`caddy-adapter.js:202`.

For `toManagedResource` at line 581 the strategy is genuinely unavailable — decide deliberately
rather than guessing: either thread it in from `configure()`/`config()`, which do know the request,
or leave inspection reporting `trusted: false` and document why. **Do not** silently flip the
inspection default to `true`; per review-context #1 and ADR-0005 inspection feeds adoption, so a
wrong value there propagates into `nomina.yaml`.

**Test to add.** `test/caddy-adapter-wire.test.js:344` only checks the publish payload
(`policy.issuers === [{ module: "internal" }]`). Add a case that calls `healthCheckExposure` with
`caStrategy: "caddy-internal-ca"` and asserts `tls: "valid"` — and keep a case asserting that a
no-CA project still reports `"untrusted"`, so the two do not collapse into each other.

---

## Priority 2 — duplication

### FIX-3 — Extract the duplicated exposure re-publish loop

- **File:** `src/cli.js:1323-1338` (in `changeBaseDomain`) and `src/cli.js:1393-1404` (in
  `handleCaddyCommand`)
- **Severity:** Medium — this loop carries the `backendTls` preservation that review-context #5
  requires "survive domain changes and edits". Duplicated, it will drift.

Both sites run the same body over their exposure list:

```js
await publishManagedExposure({
  project: workingProject,
  options: {
    name: service.name,
    hostname: service.exposure.hostname,
    backendIp: service.exposure.backend.ip,
    backendPort: Number(service.exposure.backend.port),
    backendTls: service.exposure.backend.tls === true
  },
  providerAdapters
});
```

Extract one helper, e.g. `republishExposures(workingProject, services, providerAdapters)`, and call
it from both. Note the two sites differ slightly in how they arrive at the list — `changeBaseDomain`
iterates `renamedServices` with an inline `if (service.exposure === undefined) continue;`, while
`handleCaddyCommand` pre-filters with `.filter((service) => service.exposure !== undefined)`.
Normalise on the filter inside the helper so callers just pass services.

Also note the indentation is off at `cli.js:1327-1336` (the `await` block is indented two extra
spaces inside its `for`); the extraction removes it.

### FIX-4 — De-duplicate step-ca hostname construction

- **Files:** `src/cli.js:1168-1172` (`stepCaCaHost`) and `src/exposure.js:64,69`

The same `${hostname}.${baseLocalDomain}` construction, with the same `"step-ca"` fallback, exists in
both places:

```js
// cli.js
function stepCaCaHost(project) {
  const caService = project.config.managedInventory.platform.certificateAuthority;
  const hostname = caService?.deployment?.hostname ?? "step-ca";
  return `${hostname}.${project.config.baseLocalDomain}`;
}

// exposure.js
const caHostname = caService.deployment?.hostname ?? "step-ca";
...
caHost: `${caHostname}.${project.config.baseLocalDomain}`,
```

This name matters: review-context records that using a bare IP here caused the `x509: no IP SANs`
ACME failure, and the hostname is separately pinned into the Caddy LXC's `/etc/hosts` at
`cli.js:1189`. Two copies is two places to get it wrong.

Export `stepCaCaHost` from one module (or move it to a shared helper) and call it from both. Watch
the null-safety difference — `cli.js` uses `caService?.` while `exposure.js` uses bare `caService.`;
keep the optional-chaining version.

---

## Priority 3 — clarity and dead code

### FIX-5 — Unpack the nested ternary in `uninstallEverything`

- **File:** `src/cli.js:1493`

```js
filesystem.deletePath(path.startsWith(secretStorePath) ? secretStorePath : path === statePath ? joinPath(projectDir, ".nomina") : path);
```

This is the nuclear-uninstall path — the one function where what gets deleted must be obvious on
sight. Rewrite as an explicit `if`/`else if`/`else` or a small named helper
(`resolveDeletionTarget(path)`), preserving the exact same three outcomes:

1. anything under the secret store → delete the whole secret store directory
2. the state path → delete the containing `.nomina/` directory
3. otherwise → delete the path itself

Behaviour must not change; `test/nuclear-uninstall.test.js` should pass untouched.

### FIX-6 — Remove the no-op branch in the TUI edit-exposure handler

- **File:** `src/tui.js:456-459`

`backendIp` and `backendPortRaw` are already initialised from the stored exposure at lines 444-445:

```js
let backendIp = svc.exposure.backend.ip;
let backendPortRaw = String(svc.exposure.backend.port);
```

so the `else if` branch re-assigns them to the values they already hold:

```js
} else if (adapters.prompts?.select) {
  backendIp = svc.exposure.backend.ip;
  backendPortRaw = String(svc.exposure.backend.port);
}
```

Delete the whole `else if` block (leave the `if (adapters.prompts?.ask)` branch intact). Confirmed
a genuine no-op, not defensive initialisation. `test/tui.test.js` should pass untouched.

### FIX-7 — Fix the merged-line formatting artifact

- **File:** `src/exposure.js:44`

```js
const { name, hostname, backendIp, backendPort } = options;  const dnsRef = project.state.providerReferences[dnsService.id];
```

Two statements on one line with a double space — a bad-merge artifact. Split onto two lines.

While here: lines 55-57 carry three stale comments about the Technitium `endpoint`/`ip` split that
restate what the adjacent code already says and partly contradict each other. Optional to tidy, but
do not change the values — the `ip: proxyRef?.ip ?? backendIp` at line 47 is the fix for the
"exposure DNS pointed at the backend and bypassed Caddy" bug (review-context #6). Leave it alone.

---

## Open question — not a fix, decide deliberately

### Q-1 — Redirect routes are invisible to inspection and adoption

- **File:** `src/caddy-adapter.js`, `isRedirectRoute` (line 547) as used by `configure()`/`config()`

Redirect routes are filtered out of the inspected managed-resource list. The `@id` suffix comment
says this is intentional — they are "implementation detail rather than a second managed resource" —
and that is a defensible reading of review-context #1.

But it means provider state that NominaConnect wrote is never inspected: if someone deletes or edits
a redirect route directly in Caddy, nothing notices, and `nomina caddy redirect on` will keep
reporting enabled. Worth a conscious decision (and possibly an ADR) rather than leaving it implicit.

Related: `healthCheckExposure` at line 189 only lists routes from `TLS_SERVER`, so redirect-route
health is never checked either.

---

## Suggested order

1. FIX-1 and FIX-2 first — real bugs, and both need test changes.
2. FIX-3 and FIX-4 — the extractions touch `changeBaseDomain`, which FIX-2's `caStrategy` threading
   may also brush against; doing bugs first avoids rebasing the refactor.
3. FIX-5, FIX-6, FIX-7 — independent, safe, no test churn.
4. Q-1 — discuss before writing code.

Full test run after each: `node --test` and `tsc --noEmit`. Expect 233 passing plus whatever FIX-2
adds; FIX-1 changes one existing assertion rather than adding one.
