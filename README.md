# Stride

Local-first notes. A folder is the vault. Each note is a TipTap document on disk. Git is the sync. Search is an embedded [Vane](https://github.com/ximing/vane) index (BM25 until you add an embedding key). The in-app assistant runs on pi-agent / pi-ai with your own key.

```bash
pnpm install
pnpm dev
pnpm test
pnpm tauri dev
```

Notes are `*.stride.json` files. Keys live in app settings (`~/.stride/settings.json`), sealed, never inside the vault.
