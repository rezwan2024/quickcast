import type { Countdown, FrameRate, Quality, RecordingDefaults, WebcamCorner } from '@/lib/preferences';

const QUALITY_OPTIONS: { value: Quality; label: string }[] = [
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
];
const FRAME_RATE_OPTIONS: { value: FrameRate; label: string }[] = [
  { value: 24, label: '24 fps' },
  { value: 30, label: '30 fps' },
  { value: 60, label: '60 fps' },
];
const COUNTDOWN_OPTIONS: { value: Countdown; label: string }[] = [
  { value: 0, label: 'None' },
  { value: 1, label: '1 sec' },
  { value: 2, label: '2 sec' },
  { value: 3, label: '3 sec' },
  { value: 5, label: '5 sec' },
];
const WEBCAM_CORNER_OPTIONS: { value: WebcamCorner; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

interface SelectFieldProps<T extends string | number> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}

function SelectField<T extends string | number>({ label, value, options, onChange }: SelectFieldProps<T>) {
  return (
    <div>
      <label className="text-xs font-medium tracking-wide text-[#999] uppercase">{label}</label>
      <select
        value={String(value)}
        onChange={(e) => {
          const match = options.find((o) => String(o.value) === e.target.value);
          if (match) onChange(match.value);
        }}
        className="mt-1.5 w-full rounded-lg border border-[#e5e5e5] px-3 py-2 text-sm text-[#1a1d24]"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface RecordingDefaultsSectionProps {
  value: RecordingDefaults;
  onChange: (next: RecordingDefaults) => void;
}

export function RecordingDefaultsSection({ value, onChange }: RecordingDefaultsSectionProps) {
  return (
    <section className="mt-8">
      <span className="text-xs font-medium tracking-wide text-[#999] uppercase">Recording defaults</span>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <SelectField label="Quality" value={value.quality} options={QUALITY_OPTIONS} onChange={(quality) => onChange({ ...value, quality })} />
        <SelectField
          label="Frame rate"
          value={value.frameRate}
          options={FRAME_RATE_OPTIONS}
          onChange={(frameRate) => onChange({ ...value, frameRate })}
        />
        <SelectField
          label="Countdown"
          value={value.countdown}
          options={COUNTDOWN_OPTIONS}
          onChange={(countdown) => onChange({ ...value, countdown })}
        />
        <SelectField
          label="Webcam corner"
          value={value.webcamCorner}
          options={WEBCAM_CORNER_OPTIONS}
          onChange={(webcamCorner) => onChange({ ...value, webcamCorner })}
        />
      </div>
    </section>
  );
}
