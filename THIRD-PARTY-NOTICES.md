# Third-Party Notices

Lunik UI Forge is released under the MIT License (see `LICENSE`). It depends on
the following third-party packages. Versions are the ones resolved in
`package-lock.json` at the time of writing; check the lockfile for the exact
version you installed.

| Package | Version | License | Source |
| --- | --- | --- | --- |
| `playwright` | 1.64.1 | Apache-2.0 | https://github.com/microsoft/playwright |
| `playwright-core` | 1.64.1 | Apache-2.0 | https://github.com/microsoft/playwright |
| `pngjs` | 7.0.0 | MIT | https://github.com/pngjs/pngjs |
| `pixelmatch` | 8.0.0 | ISC | https://github.com/mapbox/pixelmatch |

Each package remains under its own license and copyright. Full license text is
shipped inside `node_modules/<package>/LICENSE` after installation.

## Notes on browser binaries

`playwright` can download Chromium, Firefox, and WebKit builds. Those binaries
carry their own licenses and are **not** distributed with this repository. If
you install them, review their licenses separately. Lunik UI Forge does not
require any specific browser to be downloaded: it will use an installed Google
Chrome or Microsoft Edge via `channel` configuration if Chromium is absent.

## Research sources — not bundled

The original project brief listed fourteen public projects as inspiration
sources. Every shortened link supplied with that brief (`Inkd.in/...`) resolved
to a parked domain at the time of this implementation, so their canonical URLs,
licenses, and contents could not be verified.

Consequently **no code, assets, documentation, or distinctive text from those
projects is included in this repository.** All content here is original work
written against the product specification.

If attribution to specific upstream projects is later desired, the canonical
source URL and license for each one must be supplied and verified first, and the
relevant files — if any are copied — must be added to this file with their
license text.
