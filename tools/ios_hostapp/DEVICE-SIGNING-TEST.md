# On-device iOS signing test (SPEC-174) — Mac-free runbook

Proves the **real Swift/CryptoKit signer runs on a physical iPhone** and produces
HMAC signatures a `required`-mode server accepts. Everything below runs on
**Windows, no Mac, no Xcode** — the arm64-iOS binary is built by the CI macOS
runner (CryptoKit needs the Apple SDK), then signed + installed + launched here.

**Verified 2026-07-23:** iPhone 12 (iPhone13,2, iOS 26.5, UDID
`00008101-001C2D190EFA001E`), on-device app IP `192.168.1.36` → server
`192.168.1.40:4055`:
```
POST /v1/events  201   (signed by the SDK on the device)
POST /v1/reports 201
stats: {"accepted": 2, "rejected": 0}
```
Signed-requests-from-the-real-device are accepted. (Unsigned → 401 is proven by
`backend/tests/signals/test_signed_ingest.py` and the Android on-device test.)

---

## Prereqs (already set up on this machine — see the memory note)
- Signing workspace `C:\w\`: `zsign.exe`, `signals_sign/{cert.pem,key.pem,profile.mobileprovision}`
  (dev identity `iPhone Developer: monk0062006@gmail.com`, TeamId `2B8RPB7T5V`).
- `pymobiledevice3` on PATH (install + launch). Python (Python311) is allowed
  through the firewall, so the phone reaches the PC's LAN server.
- WebDriverAgent already installed on the iPhone.
- The phone and PC are on the **same Wi-Fi** (`192.168.1.x`).

## Step 1 — the host app signs
`Sources/SignalsHostApp.swift` reads `SIGNALS_SIGNING_SECRET` from Info.plist and
passes it to `SusaSignalsConfig(signingSecret:)`. `project.yml` sets:
```yaml
SIGNALS_ENDPOINT:       "http://192.168.1.40:4055"   # the PC's LAN IP + verify port
SIGNALS_PROJECT_ID:     "proj_ios_device_cap"
SIGNALS_SIGNING_SECRET: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"  # base64url of the 32-byte test secret
```
The endpoint has **no `/signals` suffix**, so paths post as `/v1/...` and the verify
server checks `self.path` 1:1.

## Step 2 — build the unsigned device .ipa (CI, arm64-iOS)
```bash
gh workflow run signals-ios-wire-capture.yml -R monk0062006/susa-signals
# wait for the `device-ipa` job, then:
gh run download <run-id> -R monk0062006/susa-signals -n ios-device-unsigned-ipa -D ./ipa_dl
```
Confirm the signing config baked into the built `Info.plist` (`secret set: True`).

## Step 3 — sign it (zsign, Mac-free)
```bash
MSYS_NO_PATHCONV=1 \
C:/w/zsign.exe -k C:/w/signals_sign/key.pem -c C:/w/signals_sign/cert.pem \
  -m C:/w/signals_sign/profile.mobileprovision \
  -o C:/w/signals_ipa/SignalsHostApp-signing.ipa  ./ipa_dl/SignalsHostApp-unsigned.ipa
```
(key.pem is unencrypted — no `-p`. Bundle id
`com.facebook.WebDriverAgentRunner.xctrunner.2B8RPB7T5V` is covered by the profile.)

## Step 4 — the verifying server (real `signing.verify`)
A minimal server that reuses `app.signals.signing.verify` with a fixed `required`
project (`proj_ios_device_cap`) + the matching secret, bound to `0.0.0.0:4055` so
the phone reaches it. Exposes `/health`, `/stats` (accepted/rejected), and verifies
every POST (`201` on valid signature, `401` otherwise). See
`SUSA/.../scratchpad/sign_e2e_server.py` (kept out of the shipped tree — it wraps
the real server verify code).

## Step 5 — install + launch on the device
```bash
python -m pymobiledevice3 apps install C:/w/signals_ipa/SignalsHostApp-signing.ipa
# iOS 17+: launch needs the no-root userspace developer tunnel
python -m pymobiledevice3 developer dvt launch \
  com.facebook.WebDriverAgentRunner.xctrunner.2B8RPB7T5V --userspace
```
The app drives the SDK on launch (grant consent → track events → research response
→ flush), each request HMAC-signed.

## Step 6 — verify
```bash
curl -s http://127.0.0.1:4055/stats     # accepted increments; rejected stays 0
# server.log shows the phone's LAN IP posting 201:
#   192.168.1.36 "POST /v1/events" 201
#   192.168.1.36 "POST /v1/reports" 201
```

## Gotchas hit (so they aren't re-hit)
- **Launch on iOS 17+/26** needs a developer tunnel: `pymobiledevice3 … dvt launch …
  --userspace` (no root). Without it you get "Unable to connect to Tunneld".
- **The phone posts from its Wi-Fi IP** (`192.168.1.36`), not localhost — the server
  must bind `0.0.0.0` and the endpoint must be the PC's LAN IP, not `127.0.0.1`.
- **The installed host app predating SPEC-174 has no secret** — rebuild + re-sign +
  re-install to test signing; don't reuse the old signed `.ipa`.
- **Can't build the .ipa locally** — arm64-iOS + CryptoKit needs the Apple SDK; use
  the CI `device-ipa` job.
