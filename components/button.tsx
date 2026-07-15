import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'accent' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: ReactNode;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary: 'bg-[#ef4444] text-white disabled:opacity-60',
  secondary: 'bg-[#f5f5f4] text-[#1a1d24] disabled:opacity-60',
  accent: 'bg-[#3b82f6] text-white disabled:opacity-60',
  ghost: 'bg-transparent text-[#3b82f6] hover:bg-[#3b82f6]/5 disabled:opacity-60',
};

export function Button({ variant = 'primary', icon, children, className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      className={`flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
