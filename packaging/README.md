# Release infrastructure

The source repository is public. Stable assets are published in its GitHub
Releases section by `.github/workflows/release.yml`; no cross-repository token
is required.

Before the first release:

1. Add `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to this repository.
2. Put the matching updater public key in `src-tauri/tauri.conf.json` and keep a
   backup of the private key outside GitHub.
3. Run the nightly workflow manually and test every platform artifact before
   pushing `v0.0.1`.

`AUR_ENABLED` is intentionally false/absent by default. Enabling it also
requires `AUR_SSH_PRIVATE_KEY` and an existing `modelcrew-bin` AUR package.
The release workflow accepts only the pinned Ed25519 host key in
`aur/aur.archlinux.org_known_hosts`. Its fingerprint,
`SHA256:RFzBCUItH9LZS0cKB5UE6ceAYhBD5C8GeOBip8Z11+4`, is published on the
[official AUR home page](https://aur.archlinux.org/). If Arch rotates this key,
update both the pinned key and fingerprint from an official Arch source before
re-enabling AUR publishing.

The scripts under `scripts/release` are plain Node.js modules and can be used
for local metadata validation and dry runs. Installer builds themselves still
need the corresponding operating system or a GitHub-hosted runner.

On macOS, a signed updater archive and DMG can be checked locally with the
ignored key material created in `.secrets/`:

```bash
APPLE_SIGNING_IDENTITY=- \
TAURI_SIGNING_PRIVATE_KEY="$(< .secrets/tauri-updater.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(tr -d '\n' < .secrets/tauri-updater.password)" \
npm run tauri build -- --bundles app,dmg
```

Building only `dmg` is insufficient: the `app` target is what produces the
macOS `.app.tar.gz` updater artifact and its `.sig` file.
