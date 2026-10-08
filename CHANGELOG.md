# Changelog

## 0.3.2

- Add `recover()` to restore a local device record from an existing discoverable passkey using the device recovery API.
- Try recovery before `enroll()`, `verify()`, or `signPayload()` creates a credential when local enrollment is missing. `forceNew: true` still requests a new credential.
- Exclude locally known credential IDs during creation to protect existing passkeys.
