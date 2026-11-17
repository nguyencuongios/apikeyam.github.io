# API Reference

Base URL: deployed HTTPS URL of the `api` Firebase Function.

## Common response
`{ "success": true, "code": "OK", "message": "...", "data": {}, "timestamp": 0 }`

## Public endpoints
- `GET /api/v1/server/health`
- `POST /api/v1/license/validate`
  - body: `licenseKey`, `packageId`, `tweakId`, `deviceFingerprint`
- `POST /api/v1/license/activate`
  - body: `licenseKey`, `packageId`, `tweakId`, `deviceFingerprint`, optional `deviceName`
- `POST /api/v1/license/heartbeat`
  - body: `deviceId`, `deviceFingerprint`

## Admin endpoints
All require `Authorization: Bearer <ADMIN_TOKEN>`.
- `GET /api/v1/admin/overview`
- `GET /api/v1/admin/:collection?limit=50&offset=0&q=&status=`
- `POST /api/v1/admin/:collection`
- `PATCH /api/v1/admin/:collection/:recordId`
- `DELETE /api/v1/admin/:collection/:recordId`
- `POST /api/v1/admin/package-token`
- `GET /api/v1/admin/export/:collection`

Collections: `tweaks`, `packages`, `api_keys`, `licenses`, `devices`,
`activations`, `blacklist`, `api_logs`, `audit_logs`, `settings`.

## Key storage
The admin create route hashes a supplied `licenseKey` with SHA-256 and stores
`keyHash`, not the raw key. The key is returned only to the operator at creation
time only if the frontend explicitly displays it; this baseline does not yet
implement a one-time plaintext reveal flow. For production key issuance, add a
dedicated create-key endpoint that returns the plaintext once and never stores it.
