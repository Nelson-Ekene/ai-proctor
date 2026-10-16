# Fairness harness and findings

BUILD_PLAN Phase 9.2. `pnpm --filter @proctor/e2e test:fairness` (also part of `pnpm test:e2e`)
builds a diagnostics variant of the extension (never shipped; the release check refuses it) and
runs the **exact bundled models and core frame rules** on each webcam fixture under varied
capture conditions. It reports, per condition, whether the expected outcome was reached and the
confidence of the relevant score. The latest run is written to `e2e/.cache/fairness/`.

## What is and is not measured

| Dimension (PRD/BUILD_PLAN)                                | Status                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lighting (dim, very dim, overexposed, backlit, warm)      | **Measured** (image transforms)                                                                                                                                     |
| Camera quality (low resolution, compression, noise, blur) | **Measured** (image transforms)                                                                                                                                     |
| Movement (motion blur, head/camera tilt)                  | **Measured** (image transforms)                                                                                                                                     |
| Skin tone                                                 | **Not measured.** Needs a consented dataset with self-reported labels (e.g. Monk Skin Tone scale). Recolouring images is not a valid substitute, so it is not done. |
| Glasses                                                   | **Not measured.** Needs labelled real images; synthetic overlays would mislead.                                                                                     |
| Disability-related movement                               | **Not measured.** Needs consented recordings from affected candidates, designed with them.                                                                          |

The fixture set is small (six public images, credits below), so the numbers show _where the models
are fragile_, not population-level rates. The harness accepts more fixtures: add labelled images to
`e2e/video-fixtures.ts` / `FIXTURES` in `e2e/fairness/fairness.spec.ts` and the report gains columns.

## Latest results

Measured 2026-10-11T00:09:19.947Z with the bundled models and DEFAULT_POLICY (minConfidence 0.5); median inference 230 ms per frame.

Cell: ✓/✗ expected outcome reached, then the confidence of the relevant score; (+…) lists other anomalies raised (possible false positives).

| Condition                       | Group          | Met | Mean confidence | face   | twoPeople | phone  | book              | lookingAway | noFace |
| ------------------------------- | -------------- | --- | --------------- | ------ | --------- | ------ | ----------------- | ----------- | ------ |
| Original                        | reference      | 6/6 | 0.83            | ✓ 0.95 | ✓ 0.84    | ✓ 0.68 | ✓ 0.74            | ✓ 0.87      | ✓ 0.90 |
| Dim room (35% brightness)       | lighting       | 6/6 | 0.81            | ✓ 0.95 | ✓ 0.86    | ✓ 0.52 | ✓ 0.69            | ✓ 0.85      | ✓ 1.00 |
| Very dim (20% brightness)       | lighting       | 5/6 | 0.69            | ✓ 0.94 | ✓ 0.89    | ✗ 0.00 | ✓ 0.63            | ✓ 0.82      | ✓ 0.87 |
| Overexposed (180%)              | lighting       | 4/6 | 0.57            | ✓ 0.87 | ✓ 0.70    | ✗ 0.00 | ✗ 0.00            | ✓ 0.82      | ✓ 1.00 |
| Backlit / low contrast          | lighting       | 6/6 | 0.80            | ✓ 0.93 | ✓ 0.80    | ✓ 0.68 | ✓ 0.54            | ✓ 0.85      | ✓ 1.00 |
| Warm light (sepia 60%)          | lighting       | 5/6 | 0.69            | ✓ 0.94 | ✓ 0.88    | ✗ 0.00 | ✓ 0.72            | ✓ 0.82      | ✓ 0.80 |
| Low-resolution camera (160×120) | camera quality | 5/6 | 0.71            | ✓ 0.96 | ✓ 0.80    | ✓ 0.61 | ✗ 0.00            | ✓ 0.88      | ✓ 1.00 |
| Heavy compression (JPEG q=0.1)  | camera quality | 5/6 | 0.67            | ✓ 0.95 | ✓ 0.80    | ✓ 0.61 | ✗ 0.00            | ✓ 0.82      | ✓ 0.84 |
| Sensor noise (σ≈25)             | camera quality | 5/6 | 0.64            | ✓ 0.92 | ✓ 0.77    | ✓ 0.70 | ✗ 0.00 (+no_face) | ✓ 0.67      | ✓ 0.77 |
| Out of focus (blur 3 px)        | camera quality | 5/6 | 0.67            | ✓ 0.96 | ✓ 0.77    | ✓ 0.63 | ✗ 0.00            | ✓ 0.86      | ✓ 0.82 |
| Motion blur (12 px)             | movement       | 5/6 | 0.67            | ✓ 0.93 | ✓ 0.74    | ✓ 0.58 | ✗ 0.00            | ✓ 0.88      | ✓ 0.88 |
| Head/camera tilt −20°           | movement       | 5/6 | 0.69            | ✓ 0.95 | ✓ 0.85    | ✓ 0.61 | ✗ 0.00            | ✓ 0.89      | ✓ 0.83 |
| Head/camera tilt +20°           | movement       | 6/6 | 0.81            | ✓ 0.95 | ✓ 0.90    | ✓ 0.69 | ✓ 0.63            | ✓ 0.92      | ✓ 0.75 |

- **face**: expected one face, nothing flagged (MediaPipe test asset (Apache-2.0))
- **twoPeople**: expected multiple_faces (MediaPipe test asset (Apache-2.0))
- **phone**: expected phone_detected (COCO val2017 #1296 (Flickr licence, see cocodataset.org))
- **book**: expected book_or_notes ("Middle-aged woman reading a book closeup" by Shixart1985, CC BY 2.0, Wikimedia Commons)
- **lookingAway**: expected gaze_away_sustained (COCO val2017 #4395 (Flickr licence, see cocodataset.org))
- **noFace**: expected no_face (COCO val2017 #802 (Flickr licence, see cocodataset.org))

## Findings

1. **Face presence, multiple people and looking away are robust** across every lighting, camera
   quality and movement condition tested (all ✓, confidence ≥ 0.67).
2. **Phone and book detection is fragile.** Books are missed under low resolution, compression,
   noise, blur, motion and one tilt; phones under very dim, overexposed and warm light. A missing
   flag is therefore weak evidence, so the report footer now says so
   (`REPORT_LIMITATIONS`, "Phone and book detection is less reliable…").
3. **One false positive:** with heavy sensor noise, the person reading a book was not detected as a
   face, raising "no face". Poor cameras can create no-face flags; reviewers see the frame and
   the low confidence, and the flag is advisory.

## Optional face matching (Phase 11)

`e2e/fairness/face-match.spec.ts` (same command, also `test:fairness face-match`) runs the
production face-matching path (detector keypoints, core `alignFace`, bundled SFace) in the
diagnostics build. Each fixture's unmodified photo is the reference, as if taken at the start
of a session; every fixture under every condition is a probe. This is the hard case: conditions
change _after_ the reference was taken. Fixtures: two official portraits each of three people,
taken years apart (US government, public domain; `e2e/face-fixtures.ts`).

Measured 2026-10-11T14:13:41Z; threshold `faceMatch.minSimilarity` = 0.363 (cosine similarity,
below = different face).

| Condition                       | Same photo (min) | Same person, other photo (min) | Same person read as different | Different person (max) | Different person read as same | Probes without a usable face |
| ------------------------------- | ---------------- | ------------------------------ | ----------------------------- | ---------------------- | ----------------------------- | ---------------------------- |
| Original                        | 0.996            | 0.607                          | 0/6                           | 0.242                  | 0/24                          | 0/6                          |
| Dim room (35% brightness)       | 0.792            | 0.564                          | 0/6                           | 0.217                  | 0/24                          | 0/6                          |
| Very dim (20% brightness)       | 0.718            | 0.524                          | 0/6                           | 0.205                  | 0/24                          | 0/6                          |
| Overexposed (180%)              | 0.076            | 0.145                          | 1/6                           | 0.326                  | 0/24                          | 0/6                          |
| Backlit / low contrast          | 0.905            | 0.588                          | 0/6                           | 0.239                  | 0/24                          | 0/6                          |
| Warm light (sepia 60%)          | 0.833            | 0.477                          | 0/6                           | 0.248                  | 0/24                          | 0/6                          |
| Low-resolution camera (160×120) | 0.745            | 0.550                          | 0/6                           | 0.254                  | 0/24                          | 0/6                          |
| Heavy compression (JPEG q=0.1)  | 0.731            | 0.476                          | 0/6                           | 0.288                  | 0/24                          | 0/6                          |
| Sensor noise (σ≈25)             | -0.024           | 0.136                          | 2/6                           | 0.269                  | 0/24                          | 0/6                          |
| Out of focus (blur 3 px)        | 0.624            | 0.502                          | 0/6                           | 0.199                  | 0/24                          | 0/6                          |
| Motion blur (12 px)             | 0.563            | 0.483                          | 0/6                           | 0.284                  | 0/24                          | 0/6                          |
| Head/camera tilt −20°           | 0.839            | 0.585                          | 0/6                           | 0.258                  | 0/24                          | 0/6                          |
| Head/camera tilt +20°           | 0.817            | 0.552                          | 0/6                           | 0.282                  | 0/24                          | 0/6                          |

"Same photo" includes the reference compared with itself under the condition; "same person" is
the person's other photo (years apart) against the reference.

Findings:

1. **The pipeline separates these faces** on unmodified photos with a wide margin (same person
   ≥ 0.61, different people ≤ 0.24) and under dim light, backlight, warm light, low resolution,
   compression, blur, motion and tilt.
2. **Overexposure and heavy sensor noise break it**: the _same photo_ dropped to ~0.0, so the
   same candidate would be read as a different face. If a webcam's exposure or noise changes
   badly mid-session, the candidate can be flagged. `consecutiveSamples` (3 in a row), the
   medium severity and the reference frame in the evidence are the only mitigations; the report
   footer and the per-flag guidance tell reviewers so.
3. **No different person was ever read as the same** (0/24 in every condition), but three people
   are far too few to say anything about impostor rates.
4. **Not measured at all:** skin tone, age, gender, glasses, head coverings, disability-related
   movement, real webcams. Face recognition models are known to have error rates that differ
   across demographic groups. Do not enable face matching for real candidates until it has been
   measured on a consented, labelled set of the actual candidate population and
   `minSimilarity` calibrated on it.

## Pilot plan

- Collect a consented, labelled set (skin tone, glasses, lighting, camera, disability-related
  movement) with participants; run this harness on it and publish per-group detection rates
  and confidence before any wider rollout.
- Calibrate `video.minConfidence` and severity weights per finding (e.g. lower weight for
  `book_or_notes` until detection improves).
- Track false-positive reports from reviewers (post-MVP feature, BUILD_PLAN Phase 10).
