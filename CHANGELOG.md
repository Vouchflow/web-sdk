# Changelog

## 0.3.2

- Add `recover()` to restore a local device record from an existing discoverable passkey using the device recovery API.
- Recover missing local enrollment for `enroll()`, `verify()`, and `signPayload()`; inconclusive recovery blocks credential creation unless the caller explicitly uses `enroll({ forceNew: true })`.
- Exclude locally known credential IDs during creation to protect existing passkeys.
