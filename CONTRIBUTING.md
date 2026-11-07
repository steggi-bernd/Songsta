# Contributing to Songsta

Thanks for helping improve Songsta! This document covers what you need to get a development environment running and what to expect when you open an issue or pull request.

## Getting set up

Prerequisites:

- **Windows 10/11** to run and package the Windows edition (NSIS installer)
- **macOS 11+** to run and package the macOS edition — `.dmg` artifacts can only be produced on macOS, and the Xcode Command Line Tools are needed for native build steps (`xcode-select --install`)
- **Node.js** — an up-to-date LTS version
- **Git**

```bash
git clone https://github.com/steggi-bernd/Songsta.git
cd Songsta
npm install
npm run dev
```

`npm run dev` starts Vite (renderer) and Electron together with hot reload. The app opens with its onboarding screen — **Continue as guest** is fine for development; your data is stored locally.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app in development with hot reload |
| `npm test` | Run the unit tests (`node --test`) |
| `npm run typecheck` | TypeScript check (`tsc --noEmit`) |
| `npm run build` | Typecheck + build renderer and main process |
| `npm run dist` | Full build + package for the current platform |
| `npm run dist:win` | NSIS installer into `release/` (Windows). A release also carries `latest.yml` and the `.blockmap` from there: the app's updater reads them |
| `npm run dist:mac` | DMG + ZIP, arm64 and x64, into `release/` (needs macOS) |

Before opening a pull request, please make sure `npm run typecheck` and `npm test` pass.

The Windows and macOS editions share one codebase: platform-specific behavior lives behind `process.platform` guards in `electron/main.ts`, `electron/mac-menu.ts`, `src/lib/platform.ts` and `src/lib/menuCommands.ts` — keep it that way, and check that changes work on both platforms (or are explicitly guarded).

## Reporting bugs

Open a [GitHub issue](https://github.com/steggi-bernd/Songsta/issues) and include:

- What you did and what happened
- The Songsta version (Settings → About, or the release tag)
- Your OS and version (Windows 10/11, or macOS 11+ on Apple Silicon/Intel)

For playback issues, mention whether playback fails for everything or just some tracks, and where those songs live (a folder, Jellyfin, Navidrome).

## Proposing features

Open an issue describing the problem you want solved before writing large changes. Small, focused pull requests are easier to review and more likely to land.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep changes focused; unrelated refactors make review harder.
3. Verify the app still behaves correctly — run it, play something, check the views you touched.
4. Describe what changed and why in the PR description.

## License

By contributing, you agree that your contributions are licensed under the [GNU GPL v3](LICENSE).
