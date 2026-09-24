# Third-party notices

- Electron and Chromium runtime notices are shipped with the portable distribution as `LICENSE.electron.txt` and `LICENSES.chromium.html`.
- Claude, Codex and Kimi provider icons derive from LobeHub Icons (MIT). The full notice and source revision are in `src/renderer/assets/LICENSE-LobeHub.txt`.
- The interactive terminal uses xterm.js 6.0.0, xterm addon-fit 0.11.0 and node-pty 1.1.0 (MIT). Their license files accompany their runtime files under `resources/app/node_modules` in the portable distribution; exact dependency integrity is pinned in `package-lock.json`.
- The bundled Microsoft ConPTY runtime is distributed under the MIT license. Its notice is included in `src/main/workbench/LICENSE-Microsoft-Terminal.txt`; upstream: https://github.com/microsoft/terminal/blob/main/LICENSE.
- Product and provider names belong to their respective owners. Chorus is an independent local application.
- The application icon is supplied and authorized by the project owner for distribution under the repository's MIT license; see [brand provenance](src/renderer/assets/BRAND.md).

Design references and adoption scope: [docs/REFERENCES.md](docs/REFERENCES.md).
