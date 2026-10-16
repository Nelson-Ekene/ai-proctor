import {
  BAND_LABELS,
  CATEGORY_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  VIOLATION_LABELS,
  VIOLATION_TYPES,
  type Policy,
  type Severity,
} from '@proctor/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { PolicyView } from '../api/types';
import { useAuth } from '../auth';
import { BandBadge } from '../components/BandBadge';
import { dateTime, score } from '../lib/format';
import { checkForm, toForm, weightSum, type PolicyForm } from '../lib/policy-form';
import { scoreImpact } from '../lib/preview';

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  suffix?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          aria-label={label}
          step={step}
          value={Number.isNaN(value) ? '' : value}
          onChange={(e) => {
            onChange(e.target.value === '' ? Number.NaN : Number(e.target.value));
          }}
          className="w-24 rounded border border-slate-300 px-2 py-1 text-right disabled:bg-slate-100"
        />
        <span className="w-8 text-slate-500">{suffix}</span>
      </span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-2 rounded-lg border border-slate-200 bg-white p-4">
      <legend className="px-1 font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

const SOURCE_LABEL: Record<PolicyView['effective']['source'], string> = {
  exam: 'Exam override',
  organisation: 'Organisation default',
  default: 'Built-in default (never changed)',
};

function ScorePreview({ base, draft }: { base: Policy; draft: Policy | undefined }) {
  const sessions = useQuery({
    queryKey: ['sessions', 'preview'],
    queryFn: () => api.sessions({ limit: 20 }),
  });
  const [sampleId, setSampleId] = useState('');
  const first =
    sessions.data?.sessions.find((s) => s.violationCount > 0) ?? sessions.data?.sessions[0];
  const id = sampleId || first?.id || '';
  const report = useQuery({
    queryKey: ['report', id],
    queryFn: () => api.report(id),
    enabled: id !== '',
  });
  const impact = useMemo(
    () => (report.data && draft ? scoreImpact(report.data.violations, base, draft) : undefined),
    [report.data, base, draft],
  );

  return (
    <section
      aria-label="Preview score impact"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="font-semibold">Preview score impact</h2>
      <p className="mt-1 text-sm text-slate-600">
        Re-scores a sample session&apos;s flagged moments with your changes. Saved sessions keep the
        policy they were scored with.
      </p>
      <label className="mt-3 block text-sm">
        Sample session{' '}
        <select
          value={id}
          onChange={(e) => {
            setSampleId(e.target.value);
          }}
          className="ml-1 rounded border border-slate-300 px-2 py-1"
        >
          {(sessions.data?.sessions ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.candidateRef} ({score(s.risk)})
            </option>
          ))}
        </select>
      </label>
      {!draft && (
        <p className="mt-3 text-sm text-amber-800">Fix the problems above to see a preview.</p>
      )}
      {impact && (
        <div className="mt-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span>Saved policy:</span>
            <strong className="tabular-nums" data-testid="preview-current">
              {score(impact.current.risk)}
            </strong>
            <BandBadge band={impact.current.band} />
            <span aria-hidden>→</span>
            <span>With changes:</span>
            <strong className="tabular-nums" data-testid="preview-new">
              {score(impact.preview.risk)}
            </strong>
            <BandBadge band={impact.preview.band} />
            <span className="text-slate-600">
              ({impact.delta > 0 ? '+' : ''}
              {score(impact.delta)})
            </span>
          </div>
          <ul className="mt-2 text-slate-600">
            {impact.preview.categories.map((c, i) => (
              <li key={c.category}>
                {CATEGORY_LABELS[c.category]}:{' '}
                {score(impact.current.categories[i]?.contribution ?? 0)} → {score(c.contribution)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function PolicyPage() {
  const { me } = useAuth();
  const isAdmin = me?.role === 'admin';
  const queryClient = useQueryClient();
  const exams = useQuery({ queryKey: ['exams'], queryFn: api.exams });
  const org = useQuery({ queryKey: ['organisation'], queryFn: api.organisation });
  const [examId, setExamId] = useState('');
  const view = useQuery({
    queryKey: ['policy', examId],
    queryFn: () => api.policy(examId || undefined),
  });
  const [form, setForm] = useState<PolicyForm | undefined>();
  const [message, setMessage] = useState<string | null>(null);

  const base = view.data?.effective.policy;
  const loadedKey = `${examId}:${String(view.data?.effective.versionId)}`;
  // Reset the form when another scope or a new version is loaded (state adjusted during render).
  const [formKey, setFormKey] = useState('');
  if (base && formKey !== loadedKey) {
    setFormKey(loadedKey);
    setForm(toForm(base));
  }

  const check = base && form ? checkForm(base, form) : undefined;
  const dirty = base && form ? JSON.stringify(toForm(base)) !== JSON.stringify(form) : false;

  const save = useMutation({
    mutationFn: (policy: Policy) => api.savePolicy(policy, examId || undefined),
    onSuccess: async (saved) => {
      setMessage(`Saved as version ${String(saved.version)}. New sessions will use it.`);
      await queryClient.invalidateQueries({ queryKey: ['policy'] });
    },
    onError: (err) => {
      setMessage(err instanceof ApiError ? `Not saved: ${err.message}` : 'Not saved. Try again.');
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeOverride(examId),
    onSuccess: async () => {
      setMessage('Override removed. This exam now uses the organisation default.');
      await queryClient.invalidateQueries({ queryKey: ['policy'] });
    },
  });

  const update = (patch: (f: PolicyForm) => PolicyForm) => {
    setMessage(null);
    setForm((f) => (f ? patch(f) : f));
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <h1 className="mr-auto text-xl font-semibold">Policy</h1>
        <label className="text-sm">
          Applies to{' '}
          <select
            value={examId}
            onChange={(e) => {
              setExamId(e.target.value);
              setMessage(null);
            }}
            className="ml-1 rounded border border-slate-300 px-2 py-1"
          >
            <option value="">Organisation default</option>
            {(exams.data ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                Exam: {e.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {view.isError && <p className="text-rose-700">Could not load the policy.</p>}
      {view.data && (
        <p className="text-sm text-slate-600">
          In force: {SOURCE_LABEL[view.data.effective.source]}
          {view.data.effective.version !== null &&
            `, version ${String(view.data.effective.version)}`}
          .{!isAdmin && ' Only admins can change the policy.'}
        </p>
      )}
      {org.data && (
        <p className="text-sm text-slate-600" data-testid="region-note">
          Region: {org.data.regionConfig.label}. Data is kept at most{' '}
          {org.data.regionConfig.maxRetentionDays} days here, whatever the policy says.
        </p>
      )}

      {form && base && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (check?.ok) save.mutate(check.policy);
          }}
          className="space-y-4"
        >
          <fieldset disabled={!isAdmin} className="grid gap-4 md:grid-cols-2">
            <Group title="Category weights">
              {(['browser', 'video', 'audio'] as const).map((c) => (
                <NumberField
                  key={c}
                  label={CATEGORY_LABELS[c]}
                  value={form.weights[c]}
                  suffix="%"
                  onChange={(n) => {
                    update((f) => ({ ...f, weights: { ...f.weights, [c]: n } }));
                  }}
                />
              ))}
              <p
                className={`text-right text-sm ${weightSum(form) === 100 ? 'text-slate-600' : 'font-semibold text-rose-700'}`}
                data-testid="weight-sum"
              >
                Total {weightSum(form)}% (must be 100%)
              </p>
            </Group>

            <Group title="Risk bands">
              <NumberField
                label={`${BAND_LABELS.low} up to`}
                value={form.bands.lowMax}
                onChange={(n) => {
                  update((f) => ({ ...f, bands: { ...f.bands, lowMax: n } }));
                }}
              />
              <NumberField
                label={`${BAND_LABELS.medium} up to`}
                value={form.bands.mediumMax}
                onChange={(n) => {
                  update((f) => ({ ...f, bands: { ...f.bands, mediumMax: n } }));
                }}
              />
              <p className="text-sm text-slate-600">{BAND_LABELS.high} above that.</p>
            </Group>

            <Group title="Severity points">
              {SEVERITIES.map((s) => (
                <NumberField
                  key={s}
                  label={SEVERITY_LABELS[s]}
                  value={form.severityPoints[s]}
                  onChange={(n) => {
                    update((f) => ({ ...f, severityPoints: { ...f.severityPoints, [s]: n } }));
                  }}
                />
              ))}
            </Group>

            <Group title="Severity per type">
              {VIOLATION_TYPES.map((t) => (
                <label key={t} className="flex items-center justify-between gap-3 text-sm">
                  <span>{VIOLATION_LABELS[t]}</span>
                  <select
                    value={form.severityByType[t]}
                    onChange={(e) => {
                      const severity = e.target.value as Severity;
                      update((f) => ({
                        ...f,
                        severityByType: { ...f.severityByType, [t]: severity },
                      }));
                    }}
                    className="rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {SEVERITY_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </Group>

            <Group title="Sampling and windows">
              <NumberField
                label="Webcam frames per window"
                value={form.framesPerWindow}
                onChange={(n) => {
                  update((f) => ({ ...f, framesPerWindow: n }));
                }}
              />
              <NumberField
                label="Sampling window"
                suffix="s"
                value={form.windowSeconds}
                onChange={(n) => {
                  update((f) => ({ ...f, windowSeconds: n }));
                }}
              />
              <NumberField
                label="Merge window"
                suffix="s"
                value={form.mergeWindowSeconds}
                onChange={(n) => {
                  update((f) => ({ ...f, mergeWindowSeconds: n }));
                }}
              />
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Merged count multiplies points</span>
                <input
                  type="checkbox"
                  checked={form.countMultipliesPoints}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    update((f) => ({ ...f, countMultipliesPoints: checked }));
                  }}
                />
              </label>
              <NumberField
                label="Browser events kept before a moment"
                suffix="s"
                value={form.eventsBeforeSeconds}
                onChange={(n) => {
                  update((f) => ({ ...f, eventsBeforeSeconds: n }));
                }}
              />
              <NumberField
                label="Browser events kept after a moment"
                suffix="s"
                value={form.eventsAfterSeconds}
                onChange={(n) => {
                  update((f) => ({ ...f, eventsAfterSeconds: n }));
                }}
              />
            </Group>

            <Group title="Detection and retention">
              <NumberField
                label="No activity after"
                suffix="s"
                value={form.inactivitySeconds}
                onChange={(n) => {
                  update((f) => ({ ...f, inactivitySeconds: n }));
                }}
              />
              <NumberField
                label="Looking away for at least"
                suffix="s"
                value={form.gazeSustainedSeconds}
                onChange={(n) => {
                  update((f) => ({ ...f, gazeSustainedSeconds: n }));
                }}
              />
              <NumberField
                label="Minimum model confidence"
                step={0.05}
                value={form.minConfidence}
                onChange={(n) => {
                  update((f) => ({ ...f, minConfidence: n }));
                }}
              />
              <NumberField
                label="Longest audio clip"
                suffix="s"
                value={form.maxClipSeconds}
                onChange={(n) => {
                  update((f) => ({ ...f, maxClipSeconds: n }));
                }}
              />
              <NumberField
                label="Keep data for"
                suffix="days"
                value={form.retentionDays}
                onChange={(n) => {
                  update((f) => ({ ...f, retentionDays: n }));
                }}
              />
            </Group>

            <Group title="Face matching (optional)">
              <p className="text-xs text-slate-600">
                Compares each sampled frame with a face reference taken on the candidate&apos;s
                device at the start. Runs only for candidates who opt in on the consent notice. This
                is biometric processing: check your legal basis before turning it on.
              </p>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Offer face matching to candidates</span>
                <input
                  type="checkbox"
                  checked={form.faceMatchEnabled}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    update((f) => ({ ...f, faceMatchEnabled: checked }));
                  }}
                />
              </label>
              <NumberField
                label="Minimum similarity to the reference"
                step={0.01}
                value={form.faceMatchMinSimilarity}
                onChange={(n) => {
                  update((f) => ({ ...f, faceMatchMinSimilarity: n }));
                }}
              />
              <NumberField
                label="Different-face frames in a row"
                value={form.faceMatchConsecutiveSamples}
                onChange={(n) => {
                  update((f) => ({ ...f, faceMatchConsecutiveSamples: n }));
                }}
              />
            </Group>
          </fieldset>

          {check && !check.ok && (
            <ul
              role="alert"
              className="list-disc rounded bg-rose-50 p-3 pl-7 text-sm text-rose-800"
            >
              {check.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          <ScorePreview base={base} draft={check?.ok ? check.policy : undefined} />

          {isAdmin && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={!check?.ok || !dirty || save.isPending}
                className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                Save new version
              </button>
              <button
                type="button"
                disabled={!dirty}
                onClick={() => {
                  setForm(toForm(base));
                  setMessage(null);
                }}
                className="rounded border border-slate-300 px-4 py-2 text-sm disabled:opacity-40"
              >
                Discard changes
              </button>
              {examId && view.data?.effective.source === 'exam' && (
                <button
                  type="button"
                  onClick={() => {
                    remove.mutate();
                  }}
                  className="rounded border border-slate-300 px-4 py-2 text-sm"
                >
                  Remove exam override
                </button>
              )}
            </div>
          )}
          {message && (
            <p role="status" className="text-sm text-slate-700">
              {message}
            </p>
          )}
        </form>
      )}

      {view.data && view.data.versions.length > 0 && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <h2 className="mb-2 font-semibold">Version history</h2>
          <ul>
            {view.data.versions.map((v) => (
              <li key={v.id} className="border-b border-slate-100 py-1">
                Version {v.version} · {dateTime(v.createdAt)}
                {v.policy === null && ' · override removed (uses organisation default)'}
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
