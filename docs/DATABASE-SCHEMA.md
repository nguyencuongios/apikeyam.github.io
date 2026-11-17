# Realtime Database schema

```text
tweaks/{tweakId}
packages/{packageId}
api_keys/{keyId}
  keyHash, name, packageId, tweakId, status, deviceLimit, expiresAt,
  activatedAt, createdAt, updatedAt
licenses/{licenseId}
devices/{deviceId}
  keyId, packageId, tweakId, fingerprintHash, deviceName, status,
  firstActivation, lastHeartbeat, createdAt, updatedAt
activations/{pushId}
blacklist/{entryId}
api_logs/{pushId}
audit_logs/{pushId}
settings/{settingId}
```

Recommended `.indexOn` declarations can be added after inspecting actual query
patterns. The initial rules deny all direct client access. Admin SDK requests
run server-side and bypass RTDB client rules.
