// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';
/**
 * Admin-area helpers for the Precision restyle: a switch, a toggle row
 * (label + hint + switch), a labelled field, and a modal shell. Markup only,
 * no data fetching. Kept here (not in the shared kit) because only the admin
 * pages use them.
 */
import type { ReactNode } from 'react';
import { cx } from '@/components/precision/ui';

/** A real switch: black track when on, #DADADA when off. */
export function Switch({ checked, onChange, label, disabled = false, id }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name. Required: the switch has no visible text of its own. */
  label: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex shrink-0 w-[34px] h-5 rounded-full p-0 border-0 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#245BF3]/40 focus-visible:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        checked ? 'bg-[#0A0A0A]' : 'bg-[#DADADA]',
      )}
    >
      <span
        aria-hidden="true"
        className={cx('absolute top-[3px] w-[14px] h-[14px] rounded-full bg-white transition-all', checked ? 'left-[17px]' : 'left-[3px]')}
      />
    </button>
  );
}

/** A settings row: label and hint on the left, the switch on the right. */
export function ToggleRow({ label, hint, checked, onChange, disabled, children, first = false, ariaLabel }: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Extra content under the hint (e.g. a status line). */
  children?: ReactNode;
  /** First row in a panel: no top divider. */
  first?: boolean;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
}) {
  return (
    <div className={cx('flex items-start gap-4 px-4 py-3', !first && 'border-t border-[#F2F2F2]')}>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-[14px] font-medium text-[#0A0A0A]">{label}</span>
        {hint && <span className="text-[13px] text-[#666666] leading-5">{hint}</span>}
        {children}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        label={ariaLabel ?? (typeof label === 'string' ? label : 'Toggle')}
      />
    </div>
  );
}

/** A labelled form field: 13px medium label, control, optional 12px grey hint. */
export function Field({ label, hint, children, htmlFor, className }: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cx('flex flex-col gap-1.5 text-[14px] font-medium text-[#0A0A0A] min-w-0', className)}>
      {/* One element, so text plus a required-field star stays on one line. */}
      <span>{label}</span>
      <span className="font-normal flex flex-col">{children}</span>
      {hint && <span className="text-[13px] font-normal text-[#8F8F8F] leading-5">{hint}</span>}
    </label>
  );
}

/** Modal shell: white, hairline border, 10px corners, light backdrop. */
export function Modal({ children, onClose, labelledBy, className }: {
  children: ReactNode;
  /** Called on a backdrop click. Omit to keep the modal open on backdrop clicks. */
  onClose?: () => void;
  labelledBy?: string;
  className?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(10,10,10,.25)' }}
      onClick={onClose ? (e => { if (e.target === e.currentTarget) onClose(); }) : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cx('bg-white border border-[#EAEAEA] rounded-[16px] w-full max-w-md max-h-[90vh] overflow-y-auto', className)}
      >
        {children}
      </div>
    </div>
  );
}

/** Save row at the foot of a settings panel: button plus a status message. */
export function SaveMsg({ msg, ok: okProp }: {
  msg: string | null | undefined;
  /** Force the tone; otherwise inferred from the text (Saved/Sent/Done/Copied = good). */
  ok?: boolean;
}) {
  if (!msg) return null;
  const ok = okProp ?? (/^\W*(saved|sent|done|copied|updated|created|removed|deleted)\b|success/i.test(msg) && !/fail|error|not |could ?n/i.test(msg));
  return <span className={cx('text-[13px]', ok ? 'text-[#1A7F37]' : 'text-[#B42318]')}>{msg}</span>;
}
