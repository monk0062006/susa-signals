# Generates the GPG key Maven Central requires, publishes the public half, and
# puts the private half on the clipboard for pasting into GitHub Secrets.
#
# Run it yourself:  .\scripts\setup-signing-key.ps1
#
# Nothing here writes the private key or the passphrase to disk. That is
# deliberate: this key is the release identity for com.susatest, and a copy of
# it sitting in a file is a copy that can be read by anything on the machine or
# swept up by a backup.

$ErrorActionPreference = 'Stop'

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

$existing = (gpg --list-secret-keys --keyid-format LONG 2>$null | Select-String '^sec').Count
if ($existing -gt 0) {
    Write-Host "You already have $existing secret key(s):" -ForegroundColor Yellow
    gpg --list-secret-keys --keyid-format LONG
    $reuse = Read-Host "Reuse an existing key instead of generating a new one? (y/N)"
    if ($reuse -ne 'y') { gpg --full-generate-key }
} else {
    gpg --full-generate-key
}

# Parse the long key id out of the sec line: "sec   rsa4096/A1B2C3D4E5F6A7B8 ..."
$secLine = gpg --list-secret-keys --keyid-format LONG | Select-String '^sec' | Select-Object -Last 1
if (-not $secLine) { Write-Host "No secret key found." -ForegroundColor Red; exit 1 }

$keyId = ($secLine -split '/')[1].Split(' ')[0]

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
try {
    gpg --keyserver keyserver.ubuntu.com --send-keys $keyId
    Write-Host "  published (propagation takes a few minutes)" -ForegroundColor Green
} catch {
    Write-Host "  send failed - retry later with:" -ForegroundColor Yellow
    Write-Host "    gpg --keyserver keyserver.ubuntu.com --send-keys $keyId"
}

# Straight to the clipboard, never through the terminal, so it does not end up
# in scrollback or a shell history file.
gpg --armor --export-secret-keys $keyId | clip

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
Write-Host "  gpg --armor --export-secret-keys $keyId > <removable drive>\susa-signing-key.asc"
Write-Host ""
