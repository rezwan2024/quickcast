import type { StorageBehavior } from '@/lib/preferences';

const OPTIONS: { value: StorageBehavior; label: string; description: string }[] = [
  { value: 'default', label: 'Always use default account', description: 'Every recording uploads to whichever account is marked Default above.' },
  { value: 'ask', label: 'Ask which account before each recording', description: 'Pick the account from the popup’s dropdown each time you record.' },
  { value: 'auto', label: 'Auto-switch to next account when default is 90% full', description: 'If the default account is nearly full, automatically upload to another connected account with room instead.' },
];

interface StorageBehaviorSectionProps {
  value: StorageBehavior;
  onChange: (value: StorageBehavior) => void;
}

export function StorageBehaviorSection({ value, onChange }: StorageBehaviorSectionProps) {
  return (
    <section className="mt-8">
      <span className="text-xs font-medium tracking-wide text-[#999] uppercase">Storage behavior</span>
      <div className="mt-2 space-y-2">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 ${
              value === option.value ? 'border-[#3b82f6] bg-[#3b82f6]/5' : 'border-[#e5e5e5]'
            }`}
          >
            <input
              type="radio"
              name="storage-behavior"
              className="mt-0.5 accent-[#3b82f6]"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <div>
              <p className="text-sm font-medium text-[#1a1d24]">{option.label}</p>
              <p className="text-xs text-[#666]">{option.description}</p>
            </div>
          </label>
        ))}
      </div>
    </section>
  );
}
