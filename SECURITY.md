# Security Notes

## Dependency audit

The full npm dependency audit currently reports five high-severity dependency nodes, all caused by one development-toolchain advisory: [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) / CVE-2026-112366. The vulnerable package is `picomatch <= 4.0.7`, which has a ReDoS issue involving single-branch repeated extglob patterns.

The affected nodes are `picomatch`, `fdir`, `tinyglobby`, `vite`, and `@sveltejs/vite-plugin-svelte`. In this project they are all development dependencies; they are used by the local build toolchain and are not shipped in the production browser bundle. The production-only audit (`npm audit --omit=dev`) reports no high- or critical-severity findings.

As of 18 November 2026, the advisory does not list a patched npm release. Upstream remediation proposals [#237](https://github.com/micromatch/picomatch/pull/237) and [#238](https://github.com/micromatch/picomatch/pull/238) remain unmerged. RainRelay does not consume an unmerged fork or falsely mark the advisory as fixed.

A forced downgrade to Vite 6.2.7 was evaluated and rejected: that release line has separate high-severity Vite advisories, and the downgrade also removes the current Rolldown chunk-splitting configuration. The project retains its working Vite 8 toolchain and documents the remaining development-only exception.

### Operational precautions

- Do not expose the Vite development server to untrusted networks.
- Do not pass attacker-controlled glob patterns into build or development tooling.
- Keep production dependency auditing enabled.
- Re-run the full audit when Picomatch publishes a patched release, then remove this exception and the corresponding CI allowlist.
