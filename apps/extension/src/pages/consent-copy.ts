import type { Policy } from '@proctor/core';

// Plain-language consent notice (FR11). Numbers come from the session's policy snapshot so the
// notice always matches what will actually happen.

export interface NoticeSection {
  heading: string;
  items: string[];
}

export interface ConsentNotice {
  title: string;
  intro: string;
  sections: NoticeSection[];
  agreeLabel: string;
  declineNote: string;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

export function buildConsentNotice(policy: Policy): ConsentNotice {
  const { framesPerWindow, windowSeconds } = policy.sampling;
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
          'No face recognition, identity checks or biometric templates.',
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
    agreeLabel: 'I have read this notice and agree to the collection described above.',
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
    notice.agreeLabel,
    notice.declineNote,
  ].join('\n');
}
