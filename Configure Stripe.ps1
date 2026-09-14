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
Write-Host "Invoice Desk - Stripe setup" -ForegroundColor Green
Write-Host "Start with a Stripe TEST key. Nothing is charged in test mode."
Write-Host "The key is saved as a private Windows user environment variable."
Write-Host ""

$secretKey = Read-Secret "Paste your Stripe secret key (starts with sk_test_ or sk_live_)"
if ($secretKey -notmatch '^sk_(test|live)_') {
  throw "That does not look like a Stripe secret key. No settings were changed."
}

$successUrl = Read-Host "Public HTTPS page customers should see after payment"
$successUri = $null
if (-not [Uri]::TryCreate($successUrl, [UriKind]::Absolute, [ref]$successUri) -or $successUri.Scheme -ne 'https') {
  throw "Enter a complete HTTPS URL, such as https://yourcompany.com/payment-received"
}

$cancelUrl = Read-Host "Public HTTPS page for cancelled payments (press Enter to reuse the success page)"
if ([string]::IsNullOrWhiteSpace($cancelUrl)) {
  $cancelUrl = $successUrl
}
else {
  $cancelUri = $null
  if (-not [Uri]::TryCreate($cancelUrl, [UriKind]::Absolute, [ref]$cancelUri) -or $cancelUri.Scheme -ne 'https') {
    throw "The cancellation page must be a complete HTTPS URL."
  }
}

$webhookSecret = Read-Secret "Optional webhook signing secret (whsec_...). Press Enter to skip"
if ($webhookSecret -and $webhookSecret -notmatch '^whsec_') {
  throw "That does not look like a Stripe webhook signing secret. No settings were changed."
}

[Environment]::SetEnvironmentVariable("STRIPE_SECRET_KEY", $secretKey, "User")
[Environment]::SetEnvironmentVariable("STRIPE_SUCCESS_URL", $successUrl, "User")
[Environment]::SetEnvironmentVariable("STRIPE_CANCEL_URL", $cancelUrl, "User")
[Environment]::SetEnvironmentVariable("STRIPE_WEBHOOK_SECRET", $webhookSecret, "User")

Write-Host ""
Write-Host "Stripe settings saved." -ForegroundColor Green
Write-Host "Close Invoice Desk, start it again, then check Settings for TEST or LIVE status."
Write-Host ""
Read-Host "Press Enter to close"
