param(
  [string]$CredentialsFile = "",
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

Write-Host ""
Write-Host "Invoice Desk - Gmail setup" -ForegroundColor Green
Write-Host "This stores Google OAuth application credentials, never your Gmail password."
Write-Host "Create a Web application OAuth client with this authorized redirect URI:"
Write-Host "http://127.0.0.1:3210/api/gmail/callback" -ForegroundColor Yellow
Write-Host ""

if (-not [string]::IsNullOrWhiteSpace($CredentialsFile)) {
  $resolvedCredentials = (Resolve-Path -LiteralPath $CredentialsFile).Path
  $credentialDocument = Get-Content -LiteralPath $resolvedCredentials -Raw | ConvertFrom-Json
  $webCredentials = $credentialDocument.web
  if ($null -eq $webCredentials) {
    throw "The Google credential file is not for a Web application. No settings were changed."
  }
  $clientId = [string]$webCredentials.client_id
  $clientSecret = [string]$webCredentials.client_secret
  $redirectUri = [string]($webCredentials.redirect_uris | Where-Object { $_ -eq "http://127.0.0.1:3210/api/gmail/callback" } | Select-Object -First 1)
  if ([string]::IsNullOrWhiteSpace($redirectUri)) {
    throw "The Google credential file does not contain the Invoice Desk callback address. No settings were changed."
  }
}
else {
  $clientId = Read-Host "Google OAuth Client ID"
  $clientSecret = Read-Secret "Google OAuth Client Secret"
  $redirectUri = Read-Host "Redirect URI (press Enter for the local Invoice Desk address)"
  if ([string]::IsNullOrWhiteSpace($redirectUri)) {
    $redirectUri = "http://127.0.0.1:3210/api/gmail/callback"
  }
}

if ($clientId -notmatch '\.apps\.googleusercontent\.com$') {
  throw "That does not look like a Google OAuth Client ID. No settings were changed."
}

if ([string]::IsNullOrWhiteSpace($clientSecret)) {
  throw "The Google OAuth Client Secret is required. No settings were changed."
}

$redirect = $null
if (-not [Uri]::TryCreate($redirectUri, [UriKind]::Absolute, [ref]$redirect)) {
  throw "The redirect URI is invalid. No settings were changed."
}
if ($redirect.Scheme -ne 'https' -and $redirect.Host -notin @('127.0.0.1', 'localhost')) {
  throw "Use HTTPS unless Invoice Desk is running locally. No settings were changed."
}

$tokenSecret = [Environment]::GetEnvironmentVariable("INVOICE_DESK_TOKEN_SECRET", "User")
if ([string]::IsNullOrWhiteSpace($tokenSecret)) {
  $tokenBytes = New-Object byte[] 32
  $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $randomGenerator.GetBytes($tokenBytes)
  }
  finally {
    $randomGenerator.Dispose()
  }
  $tokenSecret = [Convert]::ToBase64String($tokenBytes)
}

[Environment]::SetEnvironmentVariable("GOOGLE_CLIENT_ID", $clientId, "User")
[Environment]::SetEnvironmentVariable("GOOGLE_CLIENT_SECRET", $clientSecret, "User")
[Environment]::SetEnvironmentVariable("GOOGLE_REDIRECT_URI", $redirectUri, "User")
[Environment]::SetEnvironmentVariable("INVOICE_DESK_TOKEN_SECRET", $tokenSecret, "User")

Write-Host ""
Write-Host "Google application settings saved." -ForegroundColor Green
Write-Host "Restart Invoice Desk, open Settings, then click Connect Gmail."
Write-Host ""
if (-not $NonInteractive) {
  Read-Host "Press Enter to close"
}
