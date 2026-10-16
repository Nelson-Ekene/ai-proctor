import type { Policy } from '@proctor/core';

// Plain-language consent notice (FR11). Numbers come from the session's policy snapshot so the
// notice always matches what will actually happen.

export interface NoticeSection {
  heading: string;
  items: string[];
}

/** Optional face matching (Phase 11): its own section and its own, unticked opt-in. */
export interface FaceMatchNotice extends NoticeSection {
  optInLabel: string;
}

export interface ConsentNotice {
  title: string;
  intro: string;
  sections: NoticeSection[];
  /** Present only when the policy enables face matching. */
  faceMatch?: FaceMatchNotice;
  agreeLabel: string;
  declineNote: string;
}

function faceMatchNotice(policy: Policy): FaceMatchNotice {
  return {
    heading: 'Optional: face matching',
    items: [
      'If you tick the box below, this tool also checks during the exam that the face on camera is the same as at the start. When the camera starts, it takes a few extra photos and turns your face into a set of numbers (a face template). This is biometric data.',
      `The face template stays in this browser's memory only. It is never uploaded or saved, and it is deleted when the exam session ends.`,
      `If the face looks different in ${plural(policy.faceMatch.consecutiveSamples, 'photo', 'photos')} in a row, that moment is flagged for a person to review, with one photo from the start of the session for comparison. Face matching makes mistakes (for example with poor lighting or glasses), so a person always looks at the photos. It never decides your result.`,
      'This is your choice. If you leave the box unticked, everything else above still applies and face matching does not run.',
    ],
    optInLabel:
      'I also agree to optional face matching as described above, including the processing of my biometric data on this device.',
  };
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export function buildConsentNotice(policy: Policy): ConsentNotice {
  const { framesPerWindow, windowSeconds } = policy.sampling;
  const faceMatch = policy.faceMatch.enabled;
  return {
    title: 'Before your exam: what this proctoring tool collects',
    intro:
      'Your exam provider uses this tool to help a person review the exam afterwards. Please read what it collects, why, and for how long.',
    sections: [
      {
        heading: 'What is collected',
        items: [
          `Webcam: ${plural(framesPerWindow, 'still photo', 'still photos')} at random moments in every ${plural(windowSeconds, 'second', 'seconds')}. Photos are checked on this device for whether a face is visible, whether another person is present, and whether a phone or notes are visible. A photo is uploaded only around a moment flagged for review, together with ${plural(policy.capture.burstFrames, 'extra photo', 'extra photos')} taken at that moment.`,
          `Microphone: listened to on this device to notice speech. Nothing is recorded or uploaded unless speech is detected; then a clip of at most ${plural(policy.audio.maxClipSeconds, 'second', 'seconds')} is saved.`,
          'Browser activity: when you leave full screen, switch tabs or windows, copy or paste, try to refresh the page, or are inactive. Only the kind of event and its time are kept.',
        ],
      },
      {
        heading: 'What is never collected',
        items: [
          'No continuous video or audio recording, and no recording of your screen or the exam questions.',
          'No websites you visit, nothing you type, and nothing you paste.',
          faceMatch
            ? 'No face template is ever uploaded or saved, and nothing identifies you by name. Without your opt-in below, no face template is made at all.'
            : 'No face recognition, identity checks or biometric templates.',
        ],
      },
      {
        heading: 'Why',
        items: [
          'To give a human reviewer evidence to look at if something unusual happens. The tool only flags moments for review. It does not decide your result, and it never stops or ends your exam.',
        ],
      },
      {
        heading: 'How long',
        items: [
          `Uploaded evidence is kept for ${plural(policy.retentionDays, 'day', 'days')} and then deleted automatically.`,
        ],
      },
      {
        heading: 'While the exam runs',
        items: [
          'A red indicator is shown on the exam page, and the extension icon shows ON, whenever the camera and microphone are on.',
          'The camera and microphone turn off when the exam session ends or when you close the exam tab.',
        ],
      },
    ],
    ...(faceMatch ? { faceMatch: faceMatchNotice(policy) } : {}),
    agreeLabel: faceMatch
      ? 'I have read this notice and agree to the collection described above (except face matching, which is the separate choice below).'
      : 'I have read this notice and agree to the collection described above.',
    declineNote:
      'If you do not agree, nothing is collected. Your exam provider is told that you declined and can explain your options.',
  };
}

/** All visible strings, for wording audits. */
export function noticeText(notice: ConsentNotice): string {
  return [
    notice.title,
    notice.intro,
    ...notice.sections.flatMap((s) => [s.heading, ...s.items]),
    ...(notice.faceMatch
      ? [notice.faceMatch.heading, ...notice.faceMatch.items, notice.faceMatch.optInLabel]
      : []),
    notice.agreeLabel,
    notice.declineNote,
  ].join('\n');
}
