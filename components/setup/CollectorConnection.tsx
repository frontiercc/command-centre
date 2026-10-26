// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

// Everything an admin needs to connect Claude to this install: the collector
// address and bearer token, and the settings ready to copy. Shown on
// Admin → Ingestion and in the dashboard's Get started panel. Both routes
// that supply the bearer token are admin-only.
import { useEffect, useState } from 'react';
import { B } from '@/components/precision/ui';
import { claudeCodeSettings } from '@/lib/setup/claude-settings';
import { normaliseCollectorAddress } from '@/lib/setup/collector';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <button type="button" className={B.secondary} onClick={copy}>
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

function Row({ label, value, mono = true, children }: { label: string; value: string; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-1.5">
      <span className="w-[150px] shrink-0 text-[13px] text-[#4D4D4D]">{label}</span>
      <code className={`min-w-0 break-all text-[13px] text-[#0A0A0A] ${mono ? 'font-mono' : ''}`}>{value}</code>
      {children}
    </div>
  );
}

// Saves the address as an admin setting (otelCollectorAddress), then reads back
// the address in use, since a blank save falls back to CCC_COLLECTOR_ADDRESS.
function AddressEditor({ current, onDone }: { current: string; onDone: (address: string | null) => void }) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (normaliseCollectorAddress(value) === null) {
      setError('Enter an http or https address, such as https://otel.your-company.com');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otelCollectorAddress: value }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || 'Could not save the address');
      const status = await fetch('/api/admin/otel-status').then((s) => s.json()).catch(() => null);
      onDone(status?.collector?.address ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the address');
      setSaving(false);
    }
  };
  return (
    <div className="py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-[150px] shrink-0 text-[13px] text-[#4D4D4D]">Collector address</span>
        <input
          type="url"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://otel.your-company.com"
          className={`${B.input} min-w-[260px] flex-1 font-mono text-[13px]`}
          aria-label="Collector address"
        />
        <button type="button" className={B.primary} onClick={save} disabled={saving}>{saving ? 'Saving' : 'Save'}</button>
        <button type="button" className={B.secondary} onClick={() => onDone(current)} disabled={saving}>Cancel</button>
      </div>
      <p className="m-0 mt-1 pl-[158px] text-[12px] text-[#666666]">
        The address people&apos;s machines use to reach the collector. Leave it blank to use CCC_COLLECTOR_ADDRESS from .env if it is set, or otherwise http://localhost:4318.
      </p>
      {error && <p className="m-0 mt-1 pl-[158px] text-[12px] text-[#B42318]">{error}</p>}
    </div>
  );
}

const PLACEHOLDER = '<your bearer token>';

export default function CollectorConnection({ address: initialAddress, token }: { address: string; token: string | null }) {
  const [show, setShow] = useState(false);
  const [address, setAddress] = useState(initialAddress);
  const [editing, setEditing] = useState(false);
  useEffect(() => setAddress(initialAddress), [initialAddress]);
  const masked = '•'.repeat(16);
  return (
    <div className="text-[13px]">
      {editing ? (
        <AddressEditor
          current={address}
          onDone={(saved) => {
            if (saved) setAddress(saved);
            setEditing(false);
          }}
        />
      ) : (
        <Row label="Collector address" value={address}>
          <CopyButton text={address} label="Copy" />
          <button type="button" className={B.secondary} onClick={() => setEditing(true)}>Edit</button>
        </Row>
      )}
      {token ? (
        <Row label="Bearer token" value={show ? token : masked}>
          <button type="button" className={B.secondary} onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Show'}</button>
          <CopyButton text={token} label="Copy" />
        </Row>
      ) : (
        <div className="flex flex-wrap items-start gap-2 py-1.5">
          <span className="w-[150px] shrink-0 text-[13px] text-[#4D4D4D]">Bearer token</span>
          <p className="m-0 min-w-0 flex-1 text-[13px] text-[#4D4D4D]">
            Not shown here: this installation gives it to the collector only. It is
            <code className="mx-1 font-mono">OTEL_ENDPOINT_SECRET</code>, kept where the collector&apos;s settings
            are: in <code className="font-mono">.env</code> with Docker, in AWS Secrets Manager or in Azure Key Vault.
            Replace <code className="mx-1 font-mono">{PLACEHOLDER}</code>with it below.
          </p>
        </div>
      )}

      <p className="mt-3 mb-1.5 text-[13px] font-medium text-[#0A0A0A]">Claude Code for your organisation</p>
      <p className="m-0 mb-2 text-[13px] text-[#4D4D4D]">
        An Owner pastes these settings into claude.ai under Organization settings → Claude Code → Managed settings.
        {/localhost|127\.0\.0\.1/.test(address) && (
          <> The address above only works on this computer: for your organisation, serve the collector over HTTPS
          and enter its address with Edit.</>
        )}
        {/^http:\/\//i.test(address) && !/localhost|127\.0\.0\.1/.test(address) && (
          <> This address uses plain HTTP, so the bearer token would travel unencrypted: serve the collector over HTTPS
          and enter that address with Edit.</>
        )}
      </p>
      <pre className="m-0 mb-2 overflow-x-auto rounded border border-[#E5E5E5] bg-[#FAFAFA] p-3 font-mono text-[12px] text-[#0A0A0A]">
        {claudeCodeSettings(address, token ? (show ? token : masked) : PLACEHOLDER)}
      </pre>
      <CopyButton text={claudeCodeSettings(address, token ?? PLACEHOLDER)} label="Copy Claude Code settings" />

      <p className="mt-3 mb-1.5 text-[13px] font-medium text-[#0A0A0A]">Cowork</p>
      <p className="m-0 text-[13px] text-[#4D4D4D]">
        In Claude&apos;s Organization settings, under Data and Privacy → Monitoring, enter the collector address, the protocol
        <code className="mx-1 font-mono">http/json</code>and the header
        <code className="mx-1 font-mono">Authorization=Bearer</code>followed by the bearer token.
      </p>
    </div>
  );
}
