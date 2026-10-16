# Chrome Web Store packaging and listing

BUILD_PLAN Phase 9.4.

## Build the package

```sh
PROCTOR_EXAM_ORIGINS=https://exam.example.com \
PROCTOR_API_ORIGINS=https://api.example.com \
pnpm --filter @proctor/extension package
# → apps/extension/release/hawkeye-<version>.zip
```

The script builds in production mode into `build-release/` and refuses to package if the release
check (`apps/extension/src/release.ts`, unit-tested) finds:

- the development `key` (production builds have none; the store assigns the ID),
- an http, localhost or wildcard origin, or `<all_urls>`,
- a permission other than `offscreen`, `storage`, `alarms`, `tabs`,
- the diagnostics page (fairness harness only),
- missing bundled models.

After the first upload, put the store's extension ID into the SDK default (README "Release
checklist") so integrators need not pass `extensionId`.

## Listing

- **Single purpose:** supports human review of online exams by flagging moments (webcam,
  microphone and browser signals, plus optional on-device face matching the candidate opts in
  to) with evidence. Advisory only.
- **Category:** Education.
- **Privacy policy URL:** the organisation's published copy of `docs/privacy-policy.md`.

### Permission justifications

| Permission                                   | Why it is needed                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `offscreen`                                  | The camera and microphone run in an offscreen document (MV3 service workers cannot use media).                            |
| `storage`                                    | Keeps the session state (`chrome.storage.session`) and the evidence upload queue (IndexedDB) so uploads survive restarts. |
| `alarms`                                     | Schedules upload retries and the inactivity check, which must survive the service worker sleeping.                        |
| `tabs`                                       | Detects switching away from the exam tab and focuses/closes the consent and setup tabs.                                   |
| Host permissions (exam and API origins only) | Content script on the exam site for event types; uploads to the organisation's API. No other sites.                       |

### Data use disclosures (store form)

- Collected: **audio** (short speech clips), **images** (webcam frames around flagged moments),
  **website activity** (event types and times only, on the exam site).
- Not collected: personally identifiable information beyond what the integrator links to the
  session reference, health, financial, authentication, location, web history, user content.
- Not sold; not used for unrelated purposes; not used for creditworthiness or lending.
- **Biometric processing (optional face matching, Phase 11):** the package bundles a face
  embedding model (SFace, Apache-2.0). It runs only when the organisation's policy enables face
  matching **and** the candidate opts in separately on the consent notice. The face template is
  created and compared on the device, in memory only, and is never transmitted or stored, so it
  is not "collected" in the store form's sense; uploads remain the webcam frames above. Say this
  in the listing description and the privacy policy (template section "Optional face
  matching"), and check the current Chrome Web Store User Data policy on biometric data before
  each submission.

## Release checklist (summary)

1. `pnpm test && pnpm lint && pnpm typecheck` and `pnpm test:e2e` pass.
2. `docs/PRIVACY_REVIEW.md` re-checked; `docs/PERFORMANCE.md` budget run on a pilot laptop.
3. Package with the real origins; upload; fill the disclosures above.
4. Set the SDK default extension ID; tag the release.
