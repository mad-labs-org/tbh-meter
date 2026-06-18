# tbh-meter

Electron overlay app for Task Bar Hero — tracks DPS and run history as an always-on-top frameless window.

## Requirements

- Node >= 22
- pnpm 10

## Development

```bash
cd tbh-meter/app
pnpm install
pnpm dev
```

Opens the frameless overlay window in dev mode (hot-reload via electron-vite).

## Type-check + lint

```bash
pnpm check
```

## Build for Windows

Cross-compile from macOS (requires Wine for the NSIS installer, or build natively on Windows):

```bash
# Produces dist/ with the NSIS installer (tbh-meter-Setup-<version>.exe)
pnpm dist:win

# Local smoke-test: unpacked directory (no Wine needed on macOS)
pnpm dist:dir
```

Output lands in `dist/`.
