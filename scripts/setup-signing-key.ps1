# Generates the GPG key Maven Central requires, publishes the public half, and
# puts the private half on the clipboard for pasting into GitHub Secrets.
#
# Run it yourself:
#   powershell -ExecutionPolicy Bypass -File C:\Users\ASUS\PycharmProjects\markeriosusa\scripts\setup-signing-key.ps1
#
# Nothing here writes the private key or the passphrase to disk. That is
# deliberate: this key is the release identity for com.susatest, and a copy of
# it sitting in a file is a copy that can be read by anything on the machine or
# swept up by a backup.

# NOT 'Stop'. gpg writes all of its informational output to stderr -- even
# "directory created" -- and Windows PowerShell 5.1 wraps native stderr in an
# ErrorRecord, which under 'Stop' turns routine chatter into a fatal error.
# Exit codes are checked explicitly instead, via $LASTEXITCODE.
$ErrorActionPreference = 'Continue'

function Test-LastExit {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "$What failed (exit $LASTEXITCODE)." -ForegroundColor Red
        exit 1
    }
}

# GnuPG ships with Git for Windows but is not on PATH by default.
$gitBin = 'C:\Program Files\Git\usr\bin'
if (-not (Get-Command gpg -ErrorAction SilentlyContinue)) {
    if (Test-Path "$gitBin\gpg.exe") {
        $env:PATH += ";$gitBin"
    } else {
        Write-Host "gpg not found. Install Git for Windows or Gpg4win." -ForegroundColor Red
        exit 1
    }
}

# GnuPG 2.4 in the Git for Windows build defaults to keyboxd, a separate daemon
# that never returns on Windows -- every gpg invocation hangs indefinitely,
# including the one right after you have typed a passphrase. Disabling it makes
# gpg fall back to the classic pubring.kbx, which works.
#
# Only touched when it is the auto-generated one-line file; a hand-written
# common.conf is left alone rather than silently rewritten.
$gnupgHome = Join-Path $env:USERPROFILE '.gnupg'
$commonConf = Join-Path $gnupgHome 'common.conf'
if (Test-Path $commonConf) {
    $conf = (Get-Content $commonConf -Raw).Trim()
    if ($conf -eq 'use-keyboxd') {
        Move-Item $commonConf "$commonConf.disabled" -Force
        Remove-Item (Join-Path $gnupgHome 'S.keyboxd') -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $gnupgHome 'gnupg_spawn_keyboxd_sentinel.lock') -Force -ErrorAction SilentlyContinue
        Write-Host "Disabled keyboxd (hangs on Windows); backed up to common.conf.disabled" -ForegroundColor Yellow
    } else {
        Write-Host "common.conf has custom content - leaving it alone." -ForegroundColor Yellow
        Write-Host "If gpg hangs, the cause is 'use-keyboxd' in $commonConf"
    }
}

# A killed gpg leaves lock files that make the next run hang while it waits on
# them. Safe to clear only when no gpg process is actually running.
if (-not (Get-Process -Name 'gpg', 'gpg-agent', 'keyboxd' -ErrorAction SilentlyContinue)) {
    Get-ChildItem $gnupgHome -Force -Filter '.#lk*' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Get-ChildItem $gnupgHome -Force -Filter '*.lock' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "GPG signing key for Maven Central" -ForegroundColor Cyan
Write-Host "=================================="
Write-Host ""
Write-Host "You will be asked for:"
Write-Host "  - key type   -> choose 1 (RSA and RSA)"
Write-Host "  - key size   -> 4096"
Write-Host "  - expiry     -> 0 (does not expire)"
Write-Host "  - name/email -> your real ones; they are published"
Write-Host "  - passphrase -> THIS IS YOUR SIGNING_PASSWORD. Put it in a"
Write-Host "                  password manager now, not in a text file."
Write-Host ""

# Out-String rather than a redirect: piping native output through Select-String
# directly is what tripped the ErrorRecord wrapping above.
$existingRaw = (gpg --list-secret-keys --keyid-format LONG | Out-String)
$existing = ([regex]::Matches($existingRaw, '(?m)^sec')).Count

if ($existing -gt 0) {
    Write-Host "You already have $existing secret key(s):" -ForegroundColor Yellow
    Write-Host $existingRaw
    $reuse = Read-Host "Reuse an existing key instead of generating a new one? (y/N)"
    if ($reuse -ne 'y') {
        gpg --full-generate-key
        Test-LastExit "Key generation"
    }
} else {
    gpg --full-generate-key
    Test-LastExit "Key generation"
}

$listing = (gpg --list-secret-keys --keyid-format LONG | Out-String)
$secLines = [regex]::Matches($listing, '(?m)^sec.*$')
if ($secLines.Count -eq 0) {
    Write-Host "No secret key found after generation." -ForegroundColor Red
    exit 1
}
$secLine = $secLines[$secLines.Count - 1].Value

$keyId = ''
if ($secLine -match '/([0-9A-Fa-f]{16})') { $keyId = $Matches[1] }

# Validate before using it. An empty or malformed id would be passed straight to
# `gpg --export-secret-keys`, which with no key specified exports EVERY secret
# key on the machine - onto the clipboard. Fail here instead.
if ($keyId -notmatch '^[0-9A-Fa-f]{16}$') {
    Write-Host "Could not parse a key id from gpg output:" -ForegroundColor Red
    Write-Host "  $secLine"
    Write-Host "Export manually with: gpg --armor --export-secret-keys <KEY_ID> | clip"
    exit 1
}

Write-Host ""
Write-Host "Key id: $keyId" -ForegroundColor Green

# Central verifies signatures against a public keyserver. Skipping this makes
# every upload fail validation with an error that does not mention the cause.
Write-Host ""
Write-Host "Publishing public key to keyserver..." -ForegroundColor Cyan
gpg --keyserver keyserver.ubuntu.com --send-keys $keyId
if ($LASTEXITCODE -eq 0) {
    Write-Host "  published (propagation takes a few minutes)" -ForegroundColor Green
} else {
    # Not fatal: keyservers are flaky and this can be retried independently.
    Write-Host "  send failed - retry later with:" -ForegroundColor Yellow
    Write-Host "    gpg --keyserver keyserver.ubuntu.com --send-keys $keyId"
}

# Straight to the clipboard, never through the terminal, so it does not end up
# in scrollback or a shell history file.
$armored = (gpg --armor --export-secret-keys $keyId | Out-String)
Test-LastExit "Key export"

if ($armored -notmatch 'BEGIN PGP PRIVATE KEY BLOCK') {
    Write-Host "Export did not produce a private key block." -ForegroundColor Red
    exit 1
}

Set-Clipboard -Value $armored

Write-Host ""
Write-Host "Private key is on your clipboard." -ForegroundColor Green
Write-Host ""
Write-Host "Paste it NOW into:" -ForegroundColor Cyan
Write-Host "  https://github.com/monk0062006/susa-signals/settings/secrets/actions"
Write-Host "  New secret -> name: SIGNING_KEY"
Write-Host ""
Write-Host "Then copy something else. A private key left on the clipboard can be"
Write-Host "read by any app running on this machine."
Write-Host ""
Write-Host "Remaining secrets:" -ForegroundColor Cyan
Write-Host "  SIGNING_PASSWORD  the passphrase you just chose"
Write-Host "  MAVEN_USERNAME    central.sonatype.com -> View Account -> Generate User Token"
Write-Host "  MAVEN_PASSWORD    second half of that same token"
Write-Host ""
Write-Host "Back up the key somewhere offline:" -ForegroundColor Yellow
Write-Host "  gpg --armor --export-secret-keys $keyId > E:\susa-signing-key.asc"
Write-Host ""
