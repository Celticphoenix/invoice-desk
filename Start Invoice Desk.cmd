@echo off
cd /d "%~dp0"
echo Starting Invoice Desk...
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v STRIPE_SECRET_KEY 2^>nul ^| find "STRIPE_SECRET_KEY"') do set "STRIPE_SECRET_KEY=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v STRIPE_SUCCESS_URL 2^>nul ^| find "STRIPE_SUCCESS_URL"') do set "STRIPE_SUCCESS_URL=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v STRIPE_CANCEL_URL 2^>nul ^| find "STRIPE_CANCEL_URL"') do set "STRIPE_CANCEL_URL=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v STRIPE_WEBHOOK_SECRET 2^>nul ^| find "STRIPE_WEBHOOK_SECRET"') do set "STRIPE_WEBHOOK_SECRET=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v GOOGLE_CLIENT_ID 2^>nul ^| find "GOOGLE_CLIENT_ID"') do set "GOOGLE_CLIENT_ID=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v GOOGLE_CLIENT_SECRET 2^>nul ^| find "GOOGLE_CLIENT_SECRET"') do set "GOOGLE_CLIENT_SECRET=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v GOOGLE_REDIRECT_URI 2^>nul ^| find "GOOGLE_REDIRECT_URI"') do set "GOOGLE_REDIRECT_URI=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v INVOICE_DESK_TOKEN_SECRET 2^>nul ^| find "INVOICE_DESK_TOKEN_SECRET"') do set "INVOICE_DESK_TOKEN_SECRET=%%B"
start "Invoice Desk Server" /min node src/server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:3210
