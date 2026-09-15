# Security Setup & Environment Management Guide

## Overview
This document describes the required environment variables, authentication modes, and secret protection practices for the crypto trading bot application.

## Environment Variables Reference

| Variable Name | Required | Description | Safe Default |
|---|---|---|---|
| `NODE_ENV` | Yes | Environment mode (`development` or `production`) | `development` |
| `PORT` | Yes | HTTP server port | `3000` |
| `AUTH_MODE` | Yes | Authentication mode (`disabled`, `session`, `api-key`) | `disabled` in dev, `api-key` in prod |
| `API_ACCESS_KEY` | In Prod | Secret API key for server-to-server and admin API access | Set in production secrets manager |
| `GEMINI_API_KEY` | Optional | Server-side Gemini AI model access key | Server-side process.env only |
| `VITE_GEMINI_API_KEY` | Optional | Client-side public key fallback for AI poller | Optional browser key |
| `DATABASE_URL` | Optional | PostgreSQL connection string for cloud persistence | Local JSON store fallback |

## Security Rules & Practices
1. **Never Log or Expose Secrets**: API keys, tokens, or credentials must never be printed to logs, returned in debug API responses, or committed to source control.
2. **Production Authentication Enforcement**: In `production` mode, `AUTH_MODE=disabled` is strictly rejected. Unauthenticated mutating requests return `401 Unauthorized`.
3. **Constant-Time Verification**: API keys are verified using `crypto.timingSafeEqual` to prevent timing side-channel attacks.
4. **Git Protection**: Secret filenames (`firebase-service-account.json`, `env_dump.json`, `my_env.json`, `key_debug.txt`, `*.pem`, `*.key`) are excluded via `.gitignore`.
