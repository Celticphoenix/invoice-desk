@echo off
cd /d "%~dp0"
echo Starting Invoice Desk...
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v STRIPE_SECRET_KEY 2^>nul ^| find "STRIPE_SECRET_KEY"') do set "STRIPE_SECRET_KEY=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v STRIPE_SUCCESS_URL 2^>nul ^| find "STRIPE_SUCCESS_URL"') do set "STRIPE_SUCCESS_URL=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v STRIPE_CANCEL_URL 2^>nul ^| find "STRIPE_CANCEL_URL"') do set "STRIPE_CANCEL_URL=%%B"
for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v STRIPE_WEBHOOK_SECRET 2^>nul ^| find "STRIPE_WEBHOOK_SECRET"') do set "STRIPE_WEBHOOK_SECRET=%%B"
start "Invoice Desk Server" /min node src/server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:3210
