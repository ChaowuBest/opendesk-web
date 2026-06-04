# Remote macOS Sign — guide

End-to-end pipeline that signs an unsigned OpenDesk `.app` on a Linux host
(no local Apple developer cert needed) and notarizes on the originating mac.

The **default validated flow** is hybrid:

```
local mac                                  tcloud Linux host
─────────                                  ─────────────────
.app  (unsigned, just built)
   │ ditto -c -k                           ~/sign-server/
   │                                         secrets/      ← cert.p12, env
   ├── scp ──────────────────────►           entitlements/ ← 4 plists
   │                                         sign-once.sh
   │                                         jobs/<id>-unsigned.zip
   │                                             │
   │     ssh sign-once.sh (SKIP_NOTARIZE=1) ─►   │ rcodesign sign
   │                                             ▼
   │                                         jobs/<id>-signed.zip
   ◄──── scp ────────────────────────────────┘
.app  (signed, hardened runtime, timestamped)
   │
   ├─ xcrun notarytool submit --wait --keychain-profile opendesk-notary
   ├─ xcrun stapler staple
   ├─ xcrun stapler validate
   └─ spctl --assess --type execute
.app  (signed + notarized + stapled)  ✅
```

Why hybrid: rcodesign also has a `notary-submit` mode (fully remote), but it
requires an **App Store Connect API key** — only Account Holder / Admin roles
can create one. Until your role is upgraded, the hybrid flow uses the
local `notarytool` + app-specific-password chain you already have.

---

## What's in this directory

```
scripts/remote-sign/
├── INFO.md                 ← this file
├── entitlements/           ← copied verbatim from @electron/osx-sign defaults
│   ├── app.plist
│   ├── renderer.plist
│   ├── gpu.plist
│   └── plugin.plist
├── remote/
│   ├── bootstrap.sh        one-shot installer on the Linux host
│   └── sign-once.sh        per-job signing script
└── local/
    └── sign-via-tcloud.sh  the only command you run day-to-day
```

---

## Day-to-day usage

Full release in three commands on any mac (no Apple cert needed locally):

```bash
# 1. build the unsigned .app (forge.config.cjs is unsigned by default)
npm run build-cli && npm run build
npx electron-forge package --platform=darwin

# 2. sign on tcloud + notarize locally
SSH_TARGET=tcloud bash scripts/remote-sign/local/sign-via-tcloud.sh \
    out/opendesk-darwin-arm64/opendesk.app \
    out/signed

# 3. wrap in DMG
hdiutil create -volname OpenDesk \
    -srcfolder out/signed/opendesk.app \
    -ov -format UDZO OpenDesk.dmg
```

If you happen to be on the mac that holds the Developer ID cert **and** the
`opendesk-notary` keychain profile, you can sign+notarize during step 1 by
setting `OPENDESK_SIGN_LOCAL=1`:

```bash
OPENDESK_SIGN_LOCAL=1 npx electron-forge package --platform=darwin
# .app is already signed + notarized — skip step 2, go straight to hdiutil
```

What step 2 does internally:

1. `ditto -c -k` the unsigned bundle
2. `scp` to `tcloud:/root/sign-server/jobs/`
3. `ssh tcloud bash sign-once.sh ...` — rcodesign signs main bundle + all Helpers with their respective entitlements + hardened runtime + Apple timestamp
4. `scp` the signed `.app.zip` back, extract to `out/signed/opendesk.app`
5. `codesign --verify --deep --strict` — sanity check the signature
6. `ditto` re-zip → `xcrun notarytool submit --wait --keychain-profile opendesk-notary` — block until Apple returns Accepted (typically 3–10 min)
7. `xcrun stapler staple` + `validate`
8. `spctl --assess --type execute` — final Gatekeeper check

Typical total wall-clock: 5–8 minutes (notary wait dominates).

Output: `out/signed/opendesk.app` — fully signed, notarized, stapled. Drop it into a DMG with `hdiutil create` and ship.

Env knobs:

| Var              | Default             | Purpose                                              |
| ---------------- | ------------------- | ---------------------------------------------------- |
| `SSH_TARGET`     | required            | `tcloud` SSH alias or `user@host`                    |
| `SSH_KEY`        | ssh-agent           | path to specific private key                         |
| `REMOTE_ROOT`    | `/root/sign-server` | where bootstrap.sh installed things                  |
| `NOTARY_PROFILE` | `opendesk-notary`   | local `xcrun notarytool` keychain profile            |
| `SKIP_NOTARIZE`  | `0`                 | set to `1` to skip step 6–8 (signature-only dry run) |

---

## First-time setup on a NEW mac

Assumes the tcloud signing host is already provisioned (see next section).

1. **Clone the repo and check out the branch.**
2. **Set up an SSH alias `tcloud`** in `~/.ssh/config` (key-based auth to the tcloud signing host — ask whoever owns the host for the keypair):

    ```
    Host tcloud
        HostName    <ip-or-dns>
        User        root
        IdentityFile ~/.ssh/opendesk-signer
    ```

3. **Store the notarization credentials in the local Keychain** (one time, from the team's app-specific password — also ask the team):

    ```
    xcrun notarytool store-credentials opendesk-notary \
        --apple-id <apple-id> \
        --team-id Q294TCVCTA \
        --password <app-specific-password>
    ```

4. **Verify everything**:

    ```
    ssh tcloud 'rcodesign --version'                       # apple-codesign 0.29.0
    xcrun notarytool history --keychain-profile opendesk-notary | head -3
    ```

5. **Smoke test (sign-only, ~1 min)**:

    ```
    npm run build-cli && npm run build
    npx electron-forge package --platform=darwin

    SSH_TARGET=tcloud SKIP_NOTARIZE=1 \
        bash scripts/remote-sign/local/sign-via-tcloud.sh \
            out/opendesk-darwin-arm64/opendesk.app \
            out/dry-run
    ```

    Expected: `codesign --verify` → `valid on disk`, Authority chain includes
    `Developer ID Application: Yutao Liu (Q294TCVCTA)`, `spctl` reports
    `rejected: source=Unnotarized Developer ID` (correct for sign-only).

6. **Full run** (drops `SKIP_NOTARIZE`, takes 5–8 min): see "Day-to-day usage" above.

---

## First-time setup on the tcloud signing host

Done once by the host owner. Re-do if you provision a new host.

```bash
# from your local mac, with passwordless SSH to the host
scp scripts/remote-sign/remote/bootstrap.sh   tcloud:~/
ssh tcloud 'mkdir -p ~/sign-server/entitlements'
scp scripts/remote-sign/remote/sign-once.sh   tcloud:~/sign-server/
scp scripts/remote-sign/entitlements/*.plist  tcloud:~/sign-server/entitlements/

ssh tcloud "bash ~/bootstrap.sh"     # installs rcodesign 0.29.0

# upload the Developer ID Application .p12 (exported from Keychain Access)
scp /path/to/cert.p12 tcloud:~/sign-server/secrets/cert.p12

# write the env file
ssh tcloud "umask 077 && cat > ~/sign-server/secrets/env <<'EOF'
P12_PASSWORD=<your .p12 export password>
EOF
chmod 600 ~/sign-server/secrets/*"
```

Verify:

```bash
ssh tcloud 'ls -la ~/sign-server/secrets ~/sign-server/entitlements && rcodesign --version'
```

You should see `cert.p12` + `env` (mode 600), four `.plist` files, and
`apple-codesign 0.29.0`.

---

## Troubleshooting

| Symptom                                                                              | Cause                                                                             | Fix                                                                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| rcodesign: `encountered a non Mach-O file with a nested rule: ._XXX`                 | macOS xattr noise in the uploaded zip                                             | sign-once.sh already strips `._*` after unzip — make sure you're on the latest version                               |
| rcodesign: `verify command only works on Mach-O binaries; provided path is a Bundle` | applies `rcodesign verify` to a bundle                                            | sign-once.sh verifies only the inner Mach-O; bundle verification is done locally with `codesign`                     |
| `notarytool submit` returns `Invalid`                                                | one binary lacks hardened runtime / wrong entitlements / non-signed nested binary | `xcrun notarytool log <id> --keychain-profile opendesk-notary` lists per-file problems                               |
| `notarytool submit` returns network error mid-wait                                   | Apple infra blip; submission is still queued                                      | `xcrun notarytool info <id> --keychain-profile opendesk-notary` to keep polling, then `stapler staple` once Accepted |
| `spctl --assess` on the DMG → `rejected: source=no usable signature`                 | DMG container is not codesigned                                                   | normal — Gatekeeper uses the stapled ticket on the `.app` inside                                                     |
| `opendesk-notary` keychain profile missing                                           | macOS keychain item can disappear after long idle / sleep                         | re-run `xcrun notarytool store-credentials opendesk-notary ...`                                                      |

---

## Security notes

- `cert.p12` IS the Developer ID private key. Anyone who has the file + its
  password can sign macOS apps as Yutao Liu (Q294TCVCTA). Treat it that way:
    - `chmod 600` always
    - never in git (this repo's `.gitignore` blocks `*.p12` / `*.p8`)
    - never in logs / chat messages
    - tcloud host should not have public SSH; only a VPN / bastion reaches it
    - rotate yearly (or whenever someone with access leaves)
- The app-specific password is less critical — it only authorizes notarization
  submissions, and can be revoked individually at https://account.apple.com.
- This repo's `.claude/` directory contains a slash command `/release-mac` —
  it is in `.gitignore` because it's per-developer tooling. Don't add credentials there.

---

## Appendix — future full-remote path (rcodesign notarize)

When the Apple team gets Account Holder / Admin role on App Store Connect, a
single API Key removes the local `notarytool` step. Then:

1. Create API Key at https://appstoreconnect.apple.com/access/api → save Issuer
   ID, Key ID, and the `AuthKey_<KEYID>.p8` file (download once)
2. `scp AuthKey_<KEYID>.p8 tcloud:~/sign-server/secrets/api_key.p8`
3. Append to `~/sign-server/secrets/env`:
    ```
    APP_STORE_ISSUER_ID=<uuid>
    APP_STORE_KEY_ID=<10 chars>
    ```
4. Drop `SKIP_NOTARIZE=1` from `sign-once.sh` invocations; it will then call
   `rcodesign notary-submit --staple` on the host directly.

The local driver `sign-via-tcloud.sh` keeps doing local notarization as long
as `SKIP_NOTARIZE` is unset — to switch to the all-remote path, edit it to
pass `SKIP_NOTARIZE=0` to the remote (currently hardcoded to `1` for the
hybrid model).
