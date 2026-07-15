import type { InputHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  monospace?: boolean;
  error?: string | null;
}

export function Input({ label, monospace, error, className = '', ...rest }: InputProps) {
  return (
    <div>
      {label && (
        <label className="text-xs font-medium tracking-wide text-[#999] uppercase">{label}</label>
      )}
      <input
        className={`mt-1.5 w-full rounded-lg border px-3 py-2 text-sm text-[#1a1d24] placeholder:text-[#999] focus:outline-none ${
          monospace ? 'font-mono' : ''
        } ${error ? 'border-[#ef4444]' : 'border-[#e5e5e5] focus:border-[#3b82f6]'} ${className}`}
        {...rest}
      />
      {error && <p className="mt-1 text-xs text-[#ef4444]">{error}</p>}
    </div>
  );
}
