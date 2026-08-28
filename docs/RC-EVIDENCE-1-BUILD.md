# RC-EVIDENCE-1 Build Evidence

## Candidate

- Candidate ID: `RC-EVIDENCE-1`
- Source SHA: `5193178b84ea01b4adb4fed9fb9aa1b02b4b669a`
- Fresh rebuild: 2026-08-29 00:01:09–00:19:12 +08:00
- Target: Windows x64 NSIS

## Build Environment

- Windows 11 x64, build `26200`
- PowerShell `7.6.4`
- Node `v22.23.2`
- npm `10.9.8`
- .NET SDK `8.0.424`

## Artifact

- Installer: `Windows Block Terminal-win32-x64-0.14.5.exe`
- Size: `709442040` bytes
- SHA-256: `E917811BD03F5D0BFFC0305DDB4993F5356CEC85EBB3E35D9D34B303BE3418F`
- Packaged hosted runtime SHA-256: `24E0D2739658EFD671894F0D8786D8BE12A0B04076FF4E4051C45C162BF00FCD`
- Packaged hosted runtime was verified present in the installer.
- NSIS packaging: PASS

RC-EVIDENCE-1 is a fresh RC evidence rebuild from source SHA
`5193178b84ea01b4adb4fed9fb9aa1b02b4b669a`.

It is NOT the historical Packaging MVP 0.14.5 artifact recorded in
`docs/WINDOWS-PACKAGING-MVP-EVIDENCE.md`.

The historical artifact remains valid historical evidence only and must not be
used as the current RC-EVIDENCE-1 revalidation target.

TestDriver: NOT RUN — manual RC gate.

MSI and ZIP are not part of this candidate.

## Availability at Interactive Batch 1 Preflight

Exact declared artifact was not available at Interactive Batch 1 preflight.
A same-name local installer had a different size and SHA-256 and was rejected.
RC-EVIDENCE-1 remains historical build evidence but is no longer the active
revalidation artifact.
