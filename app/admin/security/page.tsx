// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import TopBar from '@/components/layout/TopBar';
import { useToast } from '@/components/shared/ToastProvider';
import SecretRemoveButton from '@/components/admin/SecretRemoveButton';
import { MIN_PASSWORD_LENGTH, PASSWORD_TOO_SHORT } from '@/lib/auth/password-policy';
import { PageBody, Panel, Pill, Tag, Muted, T, B, cx } from '@/components/precision/ui';

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

// The 5 secret fields handleSave() below posts to POST /api/config. The
// `ignored[]` warning must only fire for a field that was actually stored,
// not for a key that was simply never configured (posted blank every save).
// Tracked via loadedSecretsRef,
// updated whenever /api/config is (re-)fetched.
const SECURITY_SAVE_SECRET_FIELDS = [
  'anthropicAiApiKey', 'anthropicAdminApiKey', 'anthropicAnalyticsApiKey',
  'complianceAccessKey', 'otelEndpointSecret',
] as const;

function trackLoadedSecrets(ref: { current: Set<string> }, data: Record<string, unknown>) {
  for (const field of SECURITY_SAVE_SECRET_FIELDS) {
    if (String(data[field] ?? '')) {
      ref.current.add(field);
    } else {
      ref.current.delete(field);
    }
  }
}

interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'viewer' | 'manager' | 'cowork' | 'code' | 'pulse';
  department: string | null;
  linkedCoworkUserId: string | null;
  createdAt: string;
  lastLoginAt: string | number | null;
  totpEnabled?: boolean;
  otelPending?: boolean;
  autoEnrolled?: boolean;
  ssoEnabled?: boolean;
}

interface AgentRow {
  id: string;
  display_name: string | null;
}

interface ActiveSession {
  id: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: 'admin' | 'viewer' | 'manager' | 'cowork' | 'code' | 'pulse';
  createdAt: number;
  expiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

function relativeTime(value: string | number | null): string {
  if (value == null) return 'Never';
  // Handle Unix seconds (number) or ISO date string
  const ms = typeof value === 'number'
    ? value * 1000
    : /^\d+$/.test(value) ? Number(value) * 1000 : new Date(value).getTime();
  if (isNaN(ms)) return 'Never';
  const diff = Date.now() - ms;
  if (diff < 0) return 'Just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

export default function SecurityPage() {
  // --- API key state ---
  const [anthropicAiApiKey, setAnthropicAiApiKey] = useState('');
  const [anthropicAdminApiKey, setAnthropicAdminApiKey] = useState('');
  const [anthropicAnalyticsApiKey, setAnthropicAnalyticsApiKey] = useState('');
  const [complianceAccessKey, setComplianceAccessKey] = useState('');
  const [complianceLastSyncAt, setComplianceLastSyncAt] = useState('');
  const [complianceLastSyncStats, setComplianceLastSyncStats] = useState('');
  const [otelEndpointSecret, setOtelEndpointSecret] = useState('');
  // Which of SECURITY_SAVE_SECRET_FIELDS currently have a stored (non-empty,
  // masked) value. See the note above trackLoadedSecrets().
  const loadedSecretsRef = useRef<Set<string>>(new Set());
  const [testStatuses, setTestStatuses] = useState<Record<string, TestStatus>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // --- Admin users state ---
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [linkingAgentFor, setLinkingAgentFor] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'viewer' | 'manager' | 'cowork' | 'code' | 'pulse'>('admin');
  const [newDepartment, setNewDepartment] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);

  // --- Department list (from monitored users) ---
  const [departments, setDepartments] = useState<string[]>([]);

  // The suggestion list must be the UNION of departments on monitored users
  // and those already assigned to login accounts. Sourcing it from /api/users
  // alone left the picker empty on any instance where departments had only
  // ever been set on accounts — which is every instance that hasn't had
  // department data pushed onto its monitored users. Same union rule the rest
  // of the platform uses (users.department ∪ admin_users.department).
  const allDepartments = useMemo(
    () => [
      ...new Set([
        ...departments,
        ...adminUsers.map(u => u.department).filter((d): d is string => Boolean(d)),
      ]),
    ].sort(),
    [departments, adminUsers],
  );

  // --- Set department modal state ---
  const [settingDeptFor, setSettingDeptFor] = useState<string | null>(null);
  const [newDeptValue, setNewDeptValue] = useState('');
  /** True when the picker is in "add a new department" mode and newDeptValue
   *  is being typed rather than chosen. */
  const [deptAddingNew, setDeptAddingNew] = useState(false);

  // --- Change password state ---
  const [changingPasswordFor, setChangingPasswordFor] = useState<string | null>(null);
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  // --- Active sessions state ---
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [revokingSession, setRevokingSession] = useState<string | null>(null);

  // --- Admin MFA reset state ---
  const [resettingMfaFor, setResettingMfaFor] = useState<string | null>(null);

  // --- MFA state ---
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaLoading, setMfaLoading] = useState(false);
  // Setup flow
  const [mfaSetupSecret, setMfaSetupSecret] = useState<string | null>(null);
  const [mfaQrDataUrl, setMfaQrDataUrl] = useState<string | null>(null);
  const [mfaSetupCode, setMfaSetupCode] = useState('');
  const [mfaSetupError, setMfaSetupError] = useState('');
  const [mfaRecoveryCodes, setMfaRecoveryCodes] = useState<string[] | null>(null);
  // Disable flow
  const [showDisableMfa, setShowDisableMfa] = useState(false);
  const [disableMfaPassword, setDisableMfaPassword] = useState('');

  // --- SMTP state ---
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [smtpFromAddress, setSmtpFromAddress] = useState('');
  const [smtpFromName, setSmtpFromName] = useState('');
  const [savingSmtp, setSavingSmtp] = useState(false);

  // --- SSO (OIDC) state ---
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoIssuerUrl, setSsoIssuerUrl] = useState('');
  const [ssoClientId, setSsoClientId] = useState('');
  const [ssoClientSecret, setSsoClientSecret] = useState('');
  const [ssoProviderLabel, setSsoProviderLabel] = useState('SSO');
  const [ssoRedirectBaseUrl, setSsoRedirectBaseUrl] = useState('');
  const [savingSso, setSavingSso] = useState(false);
  const [ssoTestStatus, setSsoTestStatus] = useState<TestStatus>('idle');
  const [ssoTestMessage, setSsoTestMessage] = useState('');

  // --- Accounts bulk SSO selection ---
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkEnablingSso, setBulkEnablingSso] = useState(false);

  const { showToast } = useToast();

  useEffect(() => {
    const loadConfig = fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        setAnthropicAiApiKey(String(data.anthropicAiApiKey || ''));
        setAnthropicAdminApiKey(String(data.anthropicAdminApiKey || ''));
        setAnthropicAnalyticsApiKey(String(data.anthropicAnalyticsApiKey || ''));
        setComplianceAccessKey(String(data.complianceAccessKey || ''));
        setComplianceLastSyncAt(String(data.complianceLastSyncAt || ''));
        setComplianceLastSyncStats(String(data.complianceLastSyncStats || ''));
        trackLoadedSecrets(loadedSecretsRef, data);
        setOtelEndpointSecret(String(data.otelEndpointSecret || ''));
        setSmtpHost(String(data.smtpHost || ''));
        setSmtpPort(String(data.smtpPort || '587'));
        setSmtpUser(String(data.smtpUser || ''));
        setSmtpPassword(String(data.smtpPassword || ''));
        setSmtpFromAddress(String(data.smtpFromAddress || ''));
        setSmtpFromName(String(data.smtpFromName || ''));
        setSsoEnabled(Boolean(data.ssoEnabled));
        setSsoIssuerUrl(String(data.ssoIssuerUrl || ''));
        setSsoClientId(String(data.ssoClientId || ''));
        setSsoClientSecret(String(data.ssoClientSecret || ''));
        setSsoProviderLabel(String(data.ssoProviderLabel || 'SSO'));
        setSsoRedirectBaseUrl(String(data.ssoRedirectBaseUrl || ''));
      });

    const loadUsers = fetch('/api/admin/users')
      .then(r => r.json())
      .then((data: { users: AdminUser[]; agents: AgentRow[] }) => {
        setAdminUsers(data.users || []);
        setAgents(data.agents || []);
      })
      .catch(() => showToast('Failed to load admin users', 'error'));

    const loadSession = fetch('/api/admin/session')
      .then(r => r.json())
      .then(data => {
        setCurrentUserId(data?.user?.id ?? null);
        setMfaEnabled(data?.user?.totpEnabled ?? false);
      })
      .catch(() => {});

    const loadDepartments = fetch('/api/users')
      .then(r => r.json())
      .then((rows: Array<{ department?: string | null }>) => {
        const depts = [...new Set(rows.map(u => u.department).filter((d): d is string => Boolean(d)))].sort();
        setDepartments(depts);
      })
      .catch(() => {});

    const loadSessions = fetch('/api/admin/sessions')
      .then(r => r.json())
      .then((data: { sessions: ActiveSession[] }) => setActiveSessions(data.sessions || []))
      .catch(() => {});

    Promise.all([loadConfig, loadUsers, loadSession, loadDepartments, loadSessions])
      .catch(() => showToast('Failed to load configuration', 'error'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          anthropicAiApiKey,
          anthropicAdminApiKey,
          anthropicAnalyticsApiKey,
          complianceAccessKey,
          otelEndpointSecret,
        }),
      });
      if (res.ok) {
        showToast('Settings saved successfully', 'success');
        const result = await res.json();
        // Only warn about a field that was actually STORED before this save —
        // a secret that was never configured is posted blank on every save
        // (the field is legitimately empty) and must not false-alarm. See
        // the note above trackLoadedSecrets().
        const ignoredSecrets = (result.ignored ?? []).filter(
          (i: { key: string; reason: string }) =>
            i.reason === 'blank-not-clearable' && loadedSecretsRef.current.has(i.key)
        );
        if (ignoredSecrets.length > 0) {
          window.alert(
            `Not changed: ${ignoredSecrets.map((i: { key: string }) => i.key).join(', ')}.\n` +
            'Blanking a stored key does not remove it. Use its Remove button.'
          );
        }
        // Re-fetch so sensitive fields show the server's MASKED representation
        // instead of the raw value the user just typed (display only — the
        // real key is already saved; the POST route ignores masked values).
        try {
          const cfg = await fetch('/api/config').then(r => r.json());
          setAnthropicAiApiKey(String(cfg.anthropicAiApiKey || ''));
          setAnthropicAdminApiKey(String(cfg.anthropicAdminApiKey || ''));
          setAnthropicAnalyticsApiKey(String(cfg.anthropicAnalyticsApiKey || ''));
          setComplianceAccessKey(String(cfg.complianceAccessKey || ''));
          setOtelEndpointSecret(String(cfg.otelEndpointSecret || ''));
          trackLoadedSecrets(loadedSecretsRef, cfg);
        } catch { /* refresh is cosmetic; the save itself succeeded */ }
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save settings', 'error');
      }
    } catch {
      showToast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (key: string, value: string) => {
    setTestStatuses(prev => ({ ...prev, [key]: 'testing' }));
    try {
      const isUnchangedMask = value.includes('••••••••');
      const res = await fetch('/api/config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: isUnchangedMask ? undefined : value }),
      });
      const result = await res.json();
      setTestStatuses(prev => ({ ...prev, [key]: result.ok ? 'success' : 'error' }));
    } catch {
      setTestStatuses(prev => ({ ...prev, [key]: 'error' }));
    }
    setTimeout(() => setTestStatuses(prev => ({ ...prev, [key]: 'idle' })), 5000);
  };

  const handleChangeRole = async (user: AdminUser, newRole: AdminUser['role']) => {
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (res.ok) {
        setAdminUsers(prev =>
          prev.map(u => (u.id === user.id ? { ...u, role: newRole } : u))
        );
        showToast(`Role updated to ${newRole}`, 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to update role', 'error');
      }
    } catch {
      showToast('Failed to update role', 'error');
    }
  };

  const handleDeleteUser = async (user: AdminUser) => {
    if (!window.confirm(`Delete user "${user.email}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      if (res.ok) {
        setAdminUsers(prev => prev.filter(u => u.id !== user.id));
        showToast('User deleted', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to delete user', 'error');
      }
    } catch {
      showToast('Failed to delete user', 'error');
    }
  };

  const handleCreateUser = async () => {
    if (!newEmail || !newPassword) {
      showToast('Email and password are required', 'error');
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      showToast(PASSWORD_TOO_SHORT, 'error');
      return;
    }
    setCreatingUser(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail,
          password: newPassword,
          displayName: newDisplayName || undefined,
          role: newRole,
          department: newRole !== 'admin' ? (newDepartment || null) : null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setAdminUsers(prev => [...prev, data.user]);
        setShowAddForm(false);
        setNewEmail('');
        setNewDisplayName('');
        setNewPassword('');
        setNewRole('admin');
        setNewDepartment('');
        showToast('Admin user created', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to create user', 'error');
      }
    } catch {
      showToast('Failed to create user', 'error');
    } finally {
      setCreatingUser(false);
    }
  };

  const handleSetDepartment = async (userId: string) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department: newDeptValue || null }),
      });
      if (res.ok) {
        const data = await res.json();
        setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, department: data.user.department } : u));
        setSettingDeptFor(null);
        setNewDeptValue('');
        setDeptAddingNew(false);
        showToast(data.user.department ? `Department set to "${data.user.department}"` : 'Department restriction removed', 'success');
      } else {
        const data = await res.json();
        showToast(data.message || 'Failed to update department', 'error');
      }
    } catch {
      showToast('Failed to update department', 'error');
    }
  };

  const handleChangePassword = async (userId: string) => {
    if (newPw.length < MIN_PASSWORD_LENGTH) {
      showToast(PASSWORD_TOO_SHORT, 'error');
      return;
    }
    if (newPw !== confirmPw) {
      showToast('Passwords do not match', 'error');
      return;
    }
    setSavingPw(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPw }),
      });
      if (res.ok) {
        setChangingPasswordFor(null);
        setNewPw('');
        setConfirmPw('');
        showToast('Password updated, user sessions invalidated', 'success');
      } else {
        const data = await res.json();
        showToast(data.message || 'Failed to update password', 'error');
      }
    } catch {
      showToast('Failed to update password', 'error');
    } finally {
      setSavingPw(false);
    }
  };

  const handleSaveSmtp = async () => {
    setSavingSmtp(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smtpHost,
          smtpPort,
          smtpUser,
          smtpPassword,
          smtpFromAddress,
          smtpFromName,
        }),
      });
      if (res.ok) {
        showToast('SMTP settings saved', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save SMTP settings', 'error');
      }
    } catch {
      showToast('Failed to save SMTP settings', 'error');
    } finally {
      setSavingSmtp(false);
    }
  };

  const handleSaveSso = async () => {
    setSavingSso(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ssoEnabled: ssoEnabled ? 'true' : 'false',
          ssoIssuerUrl,
          ssoClientId,
          ssoClientSecret,
          ssoProviderLabel,
          ssoRedirectBaseUrl,
        }),
      });
      if (res.ok) {
        showToast('SSO settings saved', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || 'Failed to save SSO settings', 'error');
      }
    } catch {
      showToast('Failed to save SSO settings', 'error');
    } finally {
      setSavingSso(false);
    }
  };

  const handleTestSso = async () => {
    setSsoTestStatus('testing');
    setSsoTestMessage('');
    try {
      const isUnchangedMask = ssoClientSecret.includes('••••••••');
      const res = await fetch('/api/admin/sso-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issuerUrl: ssoIssuerUrl || undefined,
          clientId: ssoClientId || undefined,
          clientSecret: isUnchangedMask ? undefined : (ssoClientSecret || undefined),
        }),
      });
      const result = await res.json();
      setSsoTestStatus(result.ok ? 'success' : 'error');
      setSsoTestMessage(result.ok ? (result.issuer || 'Connected') : (result.error || 'Connection failed'));
    } catch {
      setSsoTestStatus('error');
      setSsoTestMessage('Connection failed');
    }
    setTimeout(() => setSsoTestStatus('idle'), 8000);
  };

  const handleToggleUserSso = async (userId: string, nextEnabled: boolean) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sso_enabled: nextEnabled ? 1 : 0 }),
      });
      if (res.ok) {
        setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, ssoEnabled: nextEnabled } : u));
      } else {
        const data = await res.json();
        showToast(data.message || 'Failed to update SSO access', 'error');
      }
    } catch {
      showToast('Failed to update SSO access', 'error');
    }
  };

  const toggleSelectUser = (userId: string) => {
    setSelectedUserIds(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleBulkEnableSso = async () => {
    if (selectedUserIds.size === 0) return;
    setBulkEnablingSso(true);
    try {
      const ids = Array.from(selectedUserIds);
      const results = await Promise.all(
        ids.map(id =>
          fetch(`/api/admin/users/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sso_enabled: 1 }),
          })
        )
      );
      const succeeded = new Set(ids.filter((_, i) => results[i].ok));
      setAdminUsers(prev => prev.map(u => succeeded.has(u.id) ? { ...u, ssoEnabled: true } : u));
      setSelectedUserIds(new Set());
      if (succeeded.size === ids.length) {
        showToast(`SSO enabled for ${succeeded.size} user${succeeded.size === 1 ? '' : 's'}`, 'success');
      } else {
        showToast(`SSO enabled for ${succeeded.size} of ${ids.length} users`, 'error');
      }
    } catch {
      showToast('Failed to bulk-enable SSO', 'error');
    } finally {
      setBulkEnablingSso(false);
    }
  };

  const handleLinkAgent = async (userId: string, linkedCoworkUserId: string | null) => {
    setLinkingAgentFor(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkedCoworkUserId }),
      });
      if (res.ok) {
        setAdminUsers(prev =>
          prev.map(u => u.id === userId ? { ...u, linkedCoworkUserId } : u)
        );
        showToast(linkedCoworkUserId ? 'Person linked' : 'Person unlinked', 'success');
      } else {
        showToast('Failed to update the link', 'error');
      }
    } catch {
      showToast('Failed to update the link', 'error');
    } finally {
      setLinkingAgentFor(null);
    }
  };

  const handleResetMfa = async (userId: string, email: string) => {
    if (!confirm(`Reset MFA for ${email}? They will need to set it up again next login.`)) return;
    setResettingMfaFor(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-mfa`, { method: 'POST' });
      if (res.ok) {
        showToast(`MFA reset for ${email}`, 'success');
        setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, totpEnabled: false } : u));
      } else {
        showToast('Failed to reset MFA', 'error');
      }
    } catch {
      showToast('Failed to reset MFA', 'error');
    } finally {
      setResettingMfaFor(null);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    setRevokingSession(sessionId);
    try {
      const res = await fetch('/api/admin/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        setActiveSessions(prev => prev.filter(s => s.id !== sessionId));
        showToast('Session revoked', 'success');
      } else {
        const data = await res.json();
        showToast(data.message || 'Failed to revoke session', 'error');
      }
    } catch {
      showToast('Failed to revoke session', 'error');
    } finally {
      setRevokingSession(null);
    }
  };

  const handleBeginMfaSetup = async () => {
    setMfaLoading(true);
    setMfaSetupError('');
    try {
      const res = await fetch('/api/admin/mfa/setup');
      const data = await res.json();
      if (res.ok) {
        setMfaSetupSecret(data.secret);
        setMfaQrDataUrl(data.qrDataUrl);
        setMfaSetupCode('');
      } else {
        showToast(data.error || 'Failed to start MFA setup', 'error');
      }
    } catch {
      showToast('Failed to start MFA setup', 'error');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleConfirmMfaSetup = async () => {
    if (!mfaSetupSecret) return;
    setMfaLoading(true);
    setMfaSetupError('');
    try {
      const res = await fetch('/api/admin/mfa/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: mfaSetupSecret, code: mfaSetupCode }),
      });
      const data = await res.json();
      if (res.ok) {
        setMfaEnabled(true);
        setMfaSetupSecret(null);
        setMfaQrDataUrl(null);
        setMfaSetupCode('');
        setMfaRecoveryCodes(data.recoveryCodes);
      } else {
        setMfaSetupError(data.message || 'Incorrect code. Please try again');
      }
    } catch {
      setMfaSetupError('Network error. Please try again');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleDisableMfa = async () => {
    setMfaLoading(true);
    try {
      const res = await fetch('/api/admin/mfa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: disableMfaPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setMfaEnabled(false);
        setShowDisableMfa(false);
        setDisableMfaPassword('');
        showToast('Two-factor authentication disabled', 'success');
      } else {
        showToast(data.message || 'Failed to disable MFA', 'error');
      }
    } catch {
      showToast('Failed to disable MFA', 'error');
    } finally {
      setMfaLoading(false);
    }
  };

  const adminCount = Array.isArray(adminUsers) ? adminUsers.filter(u => u.role === 'admin').length : 0;

  if (loading) {
    return (
      <>
        <TopBar title="Access & Keys" subtitle="API keys and endpoint configuration" />
        <PageBody>
          <Muted>Loading...</Muted>
        </PageBody>
      </>
    );
  }

  return (
    <>
      <TopBar title="Access & Keys" subtitle="API keys and endpoint configuration" />
      <PageBody wide>

        {/* Users */}
        <Panel
          title="Users"
          right={!showAddForm ? (
            <button type="button" onClick={() => setShowAddForm(true)} className={B.secondary}>
              + Add user
            </button>
          ) : undefined}
          flush
        >
          {/* Add user form */}
          {showAddForm && (
            <div className="px-4 py-4 border-b border-[#EAEAEA] bg-[#FAFAFA]">
              <p className="m-0 mb-3 text-[14px] font-semibold text-[#0A0A0A]">New admin user</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
                <FormField label={<>Email <span className="text-[#B42318]">*</span></>}>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder="user@example.com"
                  />
                </FormField>
                <FormField label="Display name">
                  <input
                    type="text"
                    value={newDisplayName}
                    onChange={e => setNewDisplayName(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder="Optional"
                  />
                </FormField>
                <FormField label={<>Password <span className="text-[#B42318]">*</span></>}>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`}
                  />
                </FormField>
                <FormField label="Role">
                  <select
                    value={newRole}
                    onChange={e => { setNewRole(e.target.value as 'admin' | 'viewer' | 'manager' | 'cowork' | 'code' | 'pulse'); setNewDepartment(''); }}
                    className={cx(B.select, 'w-full text-[14px]')}
                  >
                    <option value="admin">Admin</option>
                    <option value="manager">Manager</option>
                    <option value="viewer">Viewer</option>
                    <option value="cowork">Work Pulse</option>
                    <option value="code">Developer Pulse</option>
                    <option value="pulse">Pulse (Cowork + Code)</option>
                  </select>
                </FormField>
                {(newRole === 'viewer' || newRole === 'cowork') && (
                  <FormField
                    label={<>Department restriction <span className="text-[#8F8F8F] font-normal">(optional, leave blank for all departments)</span></>}
                    hint={newRole === 'cowork' ? (
                      <span className="text-[#B54708]">Required for Cowork users: scopes their Pulse data to this department.</span>
                    ) : undefined}
                  >
                    <select
                      value={newDepartment}
                      onChange={e => setNewDepartment(e.target.value)}
                      className={cx(B.select, 'w-full text-[14px]')}
                    >
                      <option value="">No restriction (all departments)</option>
                      {allDepartments.map(d => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </FormField>
                )}
              </div>
              <div className="flex gap-2 pt-4">
                <button
                  type="button"
                  onClick={handleCreateUser}
                  disabled={creatingUser}
                  className={B.primary}
                >
                  {creatingUser ? 'Creating...' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm(false);
                    setNewEmail('');
                    setNewDisplayName('');
                    setNewPassword('');
                    setNewRole('admin');
                    setNewDepartment('');
                  }}
                  className={B.secondary}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Users table */}
          {adminUsers.length === 0 ? (
            <div className="p-4"><Muted>No admin users found.</Muted></div>
          ) : (
            <>
              {selectedUserIds.size > 0 && (
                <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-2 border-b border-[#F2F2F2] bg-[#F5F8FF]">
                  <span className="text-[13px] text-[#1A44C7] font-medium tabular-nums">
                    {selectedUserIds.size} user{selectedUserIds.size === 1 ? '' : 's'} selected
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleBulkEnableSso}
                      disabled={bulkEnablingSso}
                      className={B.primary}
                    >
                      {bulkEnablingSso ? 'Enabling...' : 'Enable SSO for selected'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedUserIds(new Set())}
                      className={B.link}
                    >
                      Clear selection
                    </button>
                  </div>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className={T.table}>
                  <thead>
                    <tr className={T.headRow}>
                      <th className={cx(T.th, 'w-8')}>
                        <input
                          type="checkbox"
                          checked={adminUsers.length > 0 && selectedUserIds.size === adminUsers.length}
                          onChange={e => setSelectedUserIds(e.target.checked ? new Set(adminUsers.map(u => u.id)) : new Set())}
                          aria-label="Select all users"
                          className={CHECKBOX}
                        />
                      </th>
                      <th className={T.th}>Email</th>
                      <th className={T.th}>Display name</th>
                      <th className={T.th}>Role</th>
                      <th className={T.th}>Department</th>
                      <th className={T.th}>Linked person</th>
                      <th className={T.th}>SSO</th>
                      <th className={T.th}>Last login</th>
                      <th className={T.thRight}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminUsers.map(user => {
                      const isSelf = user.id === currentUserId;
                      const isLastAdmin = user.role === 'admin' && adminCount === 1;
                      const actionsDisabled = isSelf || isLastAdmin;

                      return (
                        <tr key={user.id} className={T.row}>
                          <td className={T.td}>
                            <input
                              type="checkbox"
                              checked={selectedUserIds.has(user.id)}
                              onChange={() => toggleSelectUser(user.id)}
                              aria-label={`Select ${user.email}`}
                              className={CHECKBOX}
                            />
                          </td>
                          <td className={cx(T.td, 'text-[#0A0A0A]')}>
                            <div className="flex items-center gap-2 flex-wrap">
                              {user.email}
                              {isSelf && (
                                <span className="text-[13px] text-[#8F8F8F]">(you)</span>
                              )}
                              {user.autoEnrolled && (
                                <Tag title="Auto-enrolled via OTel, password not yet set">auto-enrolled</Tag>
                              )}
                            </div>
                          </td>
                          <td className={T.tdMute}>
                            {user.displayName || <span className="text-[#B3B3B3]">—</span>}
                          </td>
                          <td className={T.td}>
                            <RolePill role={user.role} />
                          </td>
                          <td className={cx(T.tdMute, 'text-[13px]')}>
                            {user.role !== 'admin'
                              ? (user.department || <span className="text-[#B3B3B3]">All</span>)
                              : <span className="text-[#B3B3B3]">—</span>}
                          </td>
                          <td className={T.td}>
                            <select
                              value={user.linkedCoworkUserId ?? ''}
                              disabled={linkingAgentFor === user.id}
                              onChange={e => handleLinkAgent(user.id, e.target.value || null)}
                              className={cx(B.select, 'py-1 max-w-[160px] disabled:opacity-50')}
                              title="Link this sign-in to the same person in Claude telemetry"
                            >
                              <option value="">Not linked</option>
                              {agents.map(a => (
                                <option key={a.id} value={a.id}>
                                  {a.display_name ?? a.id}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className={T.td}>
                            <Switch
                              checked={Boolean(user.ssoEnabled)}
                              onChange={() => handleToggleUserSso(user.id, !user.ssoEnabled)}
                              title={user.ssoEnabled ? 'SSO enabled. Click to disable' : 'SSO disabled. Click to enable'}
                              label={`SSO for ${user.email}`}
                            />
                          </td>
                          <td className={cx(T.tdMute, 'text-[13px] whitespace-nowrap')}>
                            {relativeTime(user.lastLoginAt)}
                          </td>
                          <td className={T.td}>
                            <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => {
                                  setChangingPasswordFor(user.id);
                                  setNewPw('');
                                  setConfirmPw('');
                                }}
                                className={ROW_LINK}
                              >
                                Change password
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setSettingDeptFor(user.id);
                                  setNewDeptValue(user.department || '');
                                  setDeptAddingNew(false);
                                }}
                                className={ROW_LINK}
                              >
                                Set dept
                              </button>
                              {user.totpEnabled && (
                                <button
                                  type="button"
                                  onClick={() => handleResetMfa(user.id, user.email)}
                                  disabled={resettingMfaFor === user.id}
                                  className="text-[13px] font-medium text-[#B54708] hover:underline disabled:text-[#B3B3B3] disabled:no-underline disabled:cursor-not-allowed"
                                >
                                  {resettingMfaFor === user.id ? 'Resetting...' : 'Reset MFA'}
                                </button>
                              )}
                              <select
                                value={user.role}
                                disabled={actionsDisabled}
                                title={
                                  isSelf
                                    ? 'Cannot change your own role'
                                    : isLastAdmin
                                    ? 'Cannot demote the last admin'
                                    : undefined
                                }
                                aria-label={`Role for ${user.email}`}
                                onChange={e => handleChangeRole(user, e.target.value as AdminUser['role'])}
                                className={cx(B.select, 'py-1 disabled:text-[#B3B3B3] disabled:cursor-not-allowed')}
                              >
                                <option value="admin">Admin</option>
                                <option value="manager">Manager</option>
                                <option value="viewer">Viewer</option>
                                <option value="cowork">Work Pulse</option>
                                <option value="code">Developer Pulse</option>
                                <option value="pulse">Pulse (Cowork + Code)</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => handleDeleteUser(user)}
                                disabled={actionsDisabled}
                                title={
                                  isSelf
                                    ? 'Cannot delete your own account'
                                    : isLastAdmin
                                    ? 'Cannot delete the last admin'
                                    : undefined
                                }
                                className="text-[13px] font-medium text-[#B42318] hover:underline disabled:text-[#B3B3B3] disabled:no-underline disabled:cursor-not-allowed"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Panel>

        {/* Active Sessions */}
        <Panel title="Active sessions" subtitle="All currently signed-in users. Revoke any session immediately." flush>
          {activeSessions.length === 0 ? (
            <div className="p-4"><Muted>No active sessions.</Muted></div>
          ) : (
            <div className="overflow-x-auto">
              <table className={T.table}>
                <thead>
                  <tr className={T.headRow}>
                    <th className={T.th}>User</th>
                    <th className={T.th}>Role</th>
                    <th className={T.th}>Signed in</th>
                    <th className={T.th}>Expires</th>
                    <th className={T.th}>IP</th>
                    <th className={T.thRight}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSessions.map(s => (
                    <tr key={s.id} className={T.row}>
                      <td className={cx(T.td, 'text-[#0A0A0A]')}>
                        <div className="font-medium">
                          {s.displayName || s.email}
                          {s.isCurrent && (
                            <span className="ml-1.5 text-[13px] text-[#1A7F37] font-medium">(you)</span>
                          )}
                        </div>
                        {s.displayName && (
                          <div className="text-[13px] text-[#8F8F8F] mt-0.5">{s.email}</div>
                        )}
                      </td>
                      <td className={T.td}>
                        <RolePill role={s.role} />
                      </td>
                      <td className={cx(T.tdMute, 'text-[13px] whitespace-nowrap')}>{relativeTime(s.createdAt)}</td>
                      <td className={cx(T.tdMute, 'text-[13px] whitespace-nowrap tabular-nums')}>
                        {new Date(s.expiresAt * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td className={cx(T.tdMute, 'text-[13px] font-mono')}>{s.ipAddress || '—'}</td>
                      <td className={T.tdRight}>
                        {s.isCurrent ? (
                          <span className="text-[13px] text-[#8F8F8F]">Current</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRevokeSession(s.id)}
                            disabled={revokingSession === s.id}
                            className={B.danger}
                          >
                            {revokingSession === s.id ? 'Revoking...' : 'Revoke'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Change Password Modal */}
        {changingPasswordFor && (() => {
          const target = adminUsers.find(u => u.id === changingPasswordFor);
          return (
            <Modal title="Change password" subtitle={target?.email} labelId="change-password-title">
              <div className="flex flex-col gap-3">
                <FormField label="New password">
                  <input
                    type="password"
                    autoFocus
                    value={newPw}
                    onChange={e => setNewPw(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`}
                  />
                </FormField>
                <FormField label="Confirm password">
                  <input
                    type="password"
                    value={confirmPw}
                    onChange={e => setConfirmPw(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder="••••••••"
                  />
                </FormField>
                <p className="m-0 text-[13px] text-[#8F8F8F]">All active sessions for this user will be signed out.</p>
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => handleChangePassword(changingPasswordFor)}
                    disabled={savingPw}
                    className={B.primary}
                  >
                    {savingPw ? 'Saving...' : 'Update password'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setChangingPasswordFor(null); setNewPw(''); setConfirmPw(''); }}
                    className={B.secondary}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </Modal>
          );
        })()}

        {/* Set Department Modal */}
        {settingDeptFor && (() => {
          const target = adminUsers.find(u => u.id === settingDeptFor);
          return (
            <Modal title="Set department" subtitle={target?.email} labelId="set-department-title">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="set-dept-select" className="text-[14px] font-medium text-[#0A0A0A]">Department restriction</label>
                  <select
                    id="set-dept-select"
                    autoFocus
                    value={deptAddingNew ? '__new__' : newDeptValue}
                    onChange={e => {
                      if (e.target.value === '__new__') {
                        setDeptAddingNew(true);
                        setNewDeptValue('');
                      } else {
                        setDeptAddingNew(false);
                        setNewDeptValue(e.target.value);
                      }
                    }}
                    className={cx(B.select, 'w-full text-[14px]')}
                  >
                    <option value="">No restriction (all departments)</option>
                    {allDepartments.map(d => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                    <option value="__new__">+ Add a new department…</option>
                  </select>
                  {deptAddingNew && (
                    <input
                      autoFocus
                      type="text"
                      value={newDeptValue}
                      onChange={e => setNewDeptValue(e.target.value)}
                      placeholder="New department name"
                      aria-label="New department name"
                      className={cx(B.input, 'w-full')}
                    />
                  )}
                </div>
                <p className="m-0 text-[13px] text-[#8F8F8F]">
                  {newDeptValue
                    ? `This user will only see data for "${newDeptValue}".`
                    : 'This user will see data for all departments.'}
                </p>
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => handleSetDepartment(settingDeptFor)}
                    className={B.primary}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSettingDeptFor(null); setNewDeptValue(''); setDeptAddingNew(false); }}
                    className={B.secondary}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </Modal>
          );
        })()}

        {/* Two-Factor Authentication */}
        <Panel
          title="Two-factor authentication"
          subtitle="Protect your account with an authenticator app (Google Authenticator, Authy, 1Password)."
        >
          {/* Status row */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              {mfaEnabled ? (
                <>
                  <Pill tone="good">Enabled</Pill>
                  <span className="text-[14px] text-[#4D4D4D]">Your account is protected with two-factor authentication.</span>
                </>
              ) : (
                <>
                  <Pill tone="neutral">Not enabled</Pill>
                  <span className="text-[14px] text-[#666666]">Add a second layer of security to your account.</span>
                </>
              )}
            </div>
            {mfaEnabled ? (
              <button
                type="button"
                onClick={() => { setShowDisableMfa(true); setDisableMfaPassword(''); }}
                className={B.danger}
              >
                Disable 2FA
              </button>
            ) : (
              !mfaSetupSecret && (
                <button
                  type="button"
                  onClick={handleBeginMfaSetup}
                  disabled={mfaLoading}
                  className={B.primary}
                >
                  {mfaLoading ? 'Loading...' : 'Enable 2FA'}
                </button>
              )
            )}
          </div>

          {/* Setup flow — QR code + verification */}
          {mfaSetupSecret && mfaQrDataUrl && (
            <div className="mt-4 pt-4 border-t border-[#F2F2F2]">
              <p className="m-0 text-[14px] font-medium text-[#0A0A0A]">Scan this QR code</p>
              <p className="m-0 mt-0.5 mb-4 text-[13px] text-[#666666]">Open your authenticator app and scan the code below, then enter the 6-digit code to verify and enable.</p>
              <div className="flex flex-col sm:flex-row gap-6 items-start">
                <div className="shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={mfaQrDataUrl} alt="MFA QR code" className="w-40 h-40 rounded-[10px] border border-[#EAEAEA]" />
                </div>
                <div className="flex-1 min-w-0 flex flex-col gap-3 w-full">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[14px] font-medium text-[#0A0A0A]">Manual entry key</span>
                    <code className="block text-[13px] text-[#4D4D4D] bg-[#FAFAFA] border border-[#EAEAEA] px-2.5 py-1.5 rounded-[10px] font-mono break-all">{mfaSetupSecret}</code>
                  </div>
                  <FormField label={<>Verification code <span className="text-[#B42318]">*</span></>}>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={mfaSetupCode}
                      onChange={e => { setMfaSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setMfaSetupError(''); }}
                      className={cx(B.input, 'w-full max-w-xs tracking-widest font-mono')}
                      placeholder="000000"
                      maxLength={6}
                      autoFocus
                    />
                  </FormField>
                  {mfaSetupError && <p className="m-0 -mt-1 text-[13px] text-[#B42318]">{mfaSetupError}</p>}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleConfirmMfaSetup}
                      disabled={mfaLoading || mfaSetupCode.length < 6}
                      className={B.primary}
                    >
                      {mfaLoading ? 'Verifying...' : 'Verify & enable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMfaSetupSecret(null); setMfaQrDataUrl(null); setMfaSetupCode(''); setMfaSetupError(''); }}
                      className={B.secondary}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </Panel>

        {/* Recovery codes modal */}
        {mfaRecoveryCodes && (
          <Modal title="Save your recovery codes" labelId="recovery-codes-title" wide>
            <p className="m-0 mb-4 text-[13px] text-[#666666] leading-5">These codes can be used to access your account if you lose your authenticator device. Each code can only be used once. <strong className="text-[#0A0A0A]">Save them now. They won&apos;t be shown again.</strong></p>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {mfaRecoveryCodes.map(code => (
                <code key={code} className="text-[14px] font-mono bg-[#FAFAFA] px-3 py-2 rounded-[10px] text-center text-[#333333] border border-[#EAEAEA]">{code}</code>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setMfaRecoveryCodes(null)}
              className={cx(B.primary, 'w-full')}
            >
              I&apos;ve saved my recovery codes
            </button>
          </Modal>
        )}

        {/* Disable MFA modal */}
        {showDisableMfa && (
          <Modal
            title="Disable two-factor authentication"
            subtitle="Enter your password to confirm. This will remove MFA protection from your account."
            labelId="disable-mfa-title"
          >
            <div className="flex flex-col gap-3">
              <input
                type="password"
                autoFocus
                value={disableMfaPassword}
                onChange={e => setDisableMfaPassword(e.target.value)}
                className={cx(B.input, 'w-full')}
                placeholder="Your password"
                aria-label="Your password"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDisableMfa}
                  disabled={mfaLoading || !disableMfaPassword}
                  className={DANGER_SOLID}
                >
                  {mfaLoading ? 'Disabling...' : 'Disable 2FA'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowDisableMfa(false); setDisableMfaPassword(''); }}
                  className={B.secondary}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Modal>
        )}

        {/* AI Features */}
        <Panel title="AI features">
          <ApiKeyField
            label="Claude API Key"
            value={anthropicAiApiKey}
            onChange={setAnthropicAiApiKey}
            testStatus={testStatuses.anthropicAiApiKey ?? 'idle'}
            onTest={() => testConnection('anthropicAiApiKey', anthropicAiApiKey)}
            hint="A Claude API key created in the Claude Console (platform.claude.com) inside a workspace: a key that is not in a workspace is refused. Powers the intelligence briefing, anomaly detection, and AI-generated reports."
            configKey="anthropicAiApiKey"
            onRemoved={() => { setAnthropicAiApiKey(''); loadedSecretsRef.current.delete('anthropicAiApiKey'); }}
          />
        </Panel>

        {/* Enterprise APIs */}
        <Panel title="Enterprise APIs">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <ApiKeyField
                label="Compliance Access Key"
                value={complianceAccessKey}
                onChange={setComplianceAccessKey}
                testStatus={testStatuses.complianceAccessKey ?? 'idle'}
                onTest={() => testConnection('complianceAccessKey', complianceAccessKey)}
                hint="Compliance Access Key (sk-ant-api01), created in claude.ai under Organization settings → API. Enterprise plan only. Needs the scopes read:compliance_user_data and read:compliance_activities. Powers Chat capture and the organisation activity feed."
                configKey="complianceAccessKey"
                resetsNote="chat cursor, activity cursor, last-sync status"
                onRemoved={() => {
                  setComplianceAccessKey('');
                  setTestStatuses(s => ({ ...s, complianceAccessKey: 'idle' }));
                  // Removal deletes complianceLastSyncAt/complianceLastSyncStats
                  // server-side (lib/config-secrets.ts associatedKeys) — clear the
                  // stale "Last sync: ..." line here too instead of leaving it until reload.
                  setComplianceLastSyncAt('');
                  setComplianceLastSyncStats('');
                  loadedSecretsRef.current.delete('complianceAccessKey');
                }}
              />
              {complianceLastSyncAt && (
                <p className="m-0 text-[13px] text-[#666666] tabular-nums">
                  Last sync: {new Date(parseInt(complianceLastSyncAt, 10) * 1000).toLocaleString()}
                  {(() => { try { const s = JSON.parse(complianceLastSyncStats || '{}'); return ` (${s.chatsProcessed ?? 0} chats, ${s.prompts ?? 0} prompts, ${s.connectors ?? 0} connectors, ${s.activities ?? 0} activities${(s.errors?.length ?? 0) > 0 ? `, ${s.errors.length} error(s)` : ''})`; } catch { return ''; } })()}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 pt-5 border-t border-[#F2F2F2]">
              <ApiKeyField
                label="Admin API Key (on the roadmap)"
                value={anthropicAdminApiKey}
                onChange={setAnthropicAdminApiKey}
                testStatus={testStatuses.anthropicAdminApiKey ?? 'idle'}
                onTest={() => testConnection('anthropicAdminApiKey', anthropicAdminApiKey)}
                hint="Admin API key (sk-ant-admin01). Unlocks usage/cost reports and, on Claude Enterprise with the read:spend_limits scope, each person's spend limit and requests for more usage on Spend Review. Not chat content or Enterprise analytics."
                configKey="anthropicAdminApiKey"
                onRemoved={() => { setAnthropicAdminApiKey(''); loadedSecretsRef.current.delete('anthropicAdminApiKey'); }}
              />
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={() => testConnection('anthropicAdminApiKeySpendLimits', anthropicAdminApiKey)}
                  disabled={!anthropicAdminApiKey || testStatuses.anthropicAdminApiKeySpendLimits === 'testing'}
                  className={cx(B.link, 'disabled:text-[#B3B3B3] disabled:no-underline')}
                >
                  {testStatuses.anthropicAdminApiKeySpendLimits === 'testing' ? 'Checking spend limits access…' : 'Check spend limits access'}
                </button>
                {testStatuses.anthropicAdminApiKeySpendLimits === 'success' && <span className="text-[13px] text-[#1A7F37]">The key can read spend limits.</span>}
                {testStatuses.anthropicAdminApiKeySpendLimits === 'error' && <span className="text-[13px] text-[#B42318]">The key can&apos;t read spend limits. It needs read:spend_limits, a Claude Enterprise plan and usage credits turned on.</span>}
              </div>
            </div>
            <div className="pt-5 border-t border-[#F2F2F2]">
              <ApiKeyField
                label="Analytics API Key (on the roadmap)"
                value={anthropicAnalyticsApiKey}
                onChange={setAnthropicAnalyticsApiKey}
                testStatus={testStatuses.anthropicAnalyticsApiKey ?? 'idle'}
                onTest={() => testConnection('anthropicAnalyticsApiKey', anthropicAnalyticsApiKey)}
                hint="Analytics API key, created by the Primary Owner in claude.ai at claude.ai/analytics/api-keys. Enterprise plan only. Needs the read:analytics scope. Feeds per-user adoption snapshots."
                configKey="anthropicAnalyticsApiKey"
                resetsNote="last ingested date (next key re-backfills)"
                onRemoved={() => { setAnthropicAnalyticsApiKey(''); loadedSecretsRef.current.delete('anthropicAnalyticsApiKey'); }}
              />
            </div>
          </div>
        </Panel>

        {/* Endpoint Security */}
        <Panel title="Endpoint security">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="otel-endpoint-secret" className="text-[14px] font-medium text-[#0A0A0A]">
              Direct ingest secret (advanced)
            </label>
            <div className="flex gap-2">
              <input
                id="otel-endpoint-secret"
                type="text"
                value={otelEndpointSecret}
                onChange={e => setOtelEndpointSecret(e.target.value)}
                className={cx(B.input, 'flex-1 min-w-0')}
                placeholder="Leave empty when Claude sends telemetry through the collector"
              />
              <SecretRemoveButton
                configKey="otelEndpointSecret"
                label="Direct ingest secret"
                hasValue={otelEndpointSecret.length > 0}
                onRemoved={() => { setOtelEndpointSecret(''); loadedSecretsRef.current.delete('otelEndpointSecret'); }}
              />
            </div>
            <span className="text-[13px] text-[#8F8F8F] leading-5">
              Leave this empty when Claude sends telemetry through the collector, as in the Docker install: the collector checks the bearer token itself. Set it only if clients send telemetry straight to the hub, with this as their bearer token.
            </span>
          </div>
        </Panel>

        {/* Save button (API keys and endpoint secret) */}
        <div className="flex items-center gap-4 flex-wrap">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={B.primary}
          >
            {saving ? 'Saving...' : 'Save settings'}
          </button>
          <Link
            href="/audit"
            className="text-[13px] font-medium text-[#245BF3] hover:underline"
          >
            View full audit log &rarr;
          </Link>
        </div>

        {/* Single Sign-On (OIDC) */}
        <Panel title="Single sign-on (OIDC)" flush>
          <p className="m-0 px-4 pt-3 text-[13px] text-[#666666] leading-5">
            Let users sign in via your identity provider. Works with OpenID Connect providers; tested with Google Workspace and Microsoft Entra ID. For Entra, add the optional ID token claims email and xms_edov to the app registration. Only pre-provisioned accounts with SSO enabled can log in this way (see the SSO column in the Users table above). Password login always remains available as a fallback.
          </p>
          <div className="flex items-start gap-4 px-4 py-3">
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-[14px] font-medium text-[#0A0A0A]">Enable SSO</span>
              <span className="text-[13px] text-[#666666]">Shows the SSO button on the login page and activates the callback route.</span>
            </div>
            <Switch
              checked={ssoEnabled}
              onChange={() => setSsoEnabled(v => !v)}
              label="Enable SSO"
            />
          </div>

          <div className="px-4 py-4 border-t border-[#F2F2F2] flex flex-col gap-4">
            <FormField label="Issuer URL">
              <input
                type="text"
                value={ssoIssuerUrl}
                onChange={e => setSsoIssuerUrl(e.target.value)}
                className={cx(B.input, 'w-full')}
                placeholder="https://accounts.google.com"
              />
            </FormField>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField label="Client ID">
                <input
                  type="text"
                  value={ssoClientId}
                  onChange={e => setSsoClientId(e.target.value)}
                  className={cx(B.input, 'w-full')}
                  placeholder="Client ID from your IdP app registration"
                />
              </FormField>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="sso-client-secret" className="text-[14px] font-medium text-[#0A0A0A]">Client secret</label>
                <div className="flex gap-2">
                  <input
                    id="sso-client-secret"
                    type="password"
                    value={ssoClientSecret}
                    onChange={e => setSsoClientSecret(e.target.value)}
                    className={cx(B.input, 'flex-1 min-w-0')}
                    placeholder="••••••••"
                  />
                  <SecretRemoveButton
                    configKey="ssoClientSecret"
                    label="SSO client secret"
                    hasValue={ssoClientSecret.length > 0}
                    onRemoved={() => setSsoClientSecret('')}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                label="Provider label"
                hint={<>Shown on the login button: &quot;Sign in with {ssoProviderLabel || 'SSO'}&quot;.</>}
              >
                <input
                  type="text"
                  value={ssoProviderLabel}
                  onChange={e => setSsoProviderLabel(e.target.value)}
                  className={cx(B.input, 'w-full')}
                  placeholder="Google, Okta, Microsoft…"
                />
              </FormField>
              <FormField label="Redirect base URL">
                <input
                  type="text"
                  value={ssoRedirectBaseUrl}
                  onChange={e => setSsoRedirectBaseUrl(e.target.value)}
                  className={cx(B.input, 'w-full')}
                  placeholder="https://ccc.example.com"
                />
              </FormField>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[14px] font-medium text-[#0A0A0A]">Callback URI (register this with your IdP)</span>
              <code className="block text-[13px] text-[#4D4D4D] bg-[#FAFAFA] px-2.5 py-1.5 rounded-[10px] font-mono break-all border border-[#EAEAEA]">
                {ssoRedirectBaseUrl ? `${ssoRedirectBaseUrl.replace(/\/$/, '')}/api/auth/sso/callback` : '(set a redirect base URL above)'}
              </code>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap px-4 py-3 border-t border-[#F2F2F2]">
            <button
              type="button"
              onClick={handleSaveSso}
              disabled={savingSso}
              className={B.primary}
            >
              {savingSso ? 'Saving...' : 'Save SSO settings'}
            </button>
            <button
              type="button"
              onClick={handleTestSso}
              disabled={ssoTestStatus === 'testing'}
              className={testButtonClass(ssoTestStatus)}
            >
              {ssoTestStatus === 'testing' ? 'Testing...' : ssoTestStatus === 'success' ? 'Connected' : ssoTestStatus === 'error' ? 'Failed' : 'Test connection'}
            </button>
            {ssoTestMessage && (
              <span className={cx('text-[13px]', ssoTestStatus === 'error' ? 'text-[#B42318]' : 'text-[#666666]')}>
                {ssoTestMessage}
              </span>
            )}
          </div>
        </Panel>

        {/* Email / SMTP */}
        <Panel title="Email (SMTP)" flush>
          <p className="m-0 px-4 pt-3 text-[13px] text-[#666666] leading-5">
            Required for password reset emails. Use any SMTP provider: your domain host, Resend, Postmark, etc. Port 587 (TLS) is recommended.
          </p>
          <div className="px-4 py-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2">
                <FormField label="SMTP host">
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={e => setSmtpHost(e.target.value)}
                    className={cx(B.input, 'w-full')}
                    placeholder="smtp.example.com"
                  />
                </FormField>
              </div>
              <FormField label="Port">
                <input
                  type="text"
                  value={smtpPort}
                  onChange={e => setSmtpPort(e.target.value)}
                  className={cx(B.input, 'w-full')}
                  placeholder="587"
                />
              </FormField>
            </div>
            <FormField label="SMTP username">
              <input
                type="text"
                value={smtpUser}
                onChange={e => setSmtpUser(e.target.value)}
                className={cx(B.input, 'w-full')}
                placeholder="user@example.com"
              />
            </FormField>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="smtp-password" className="text-[14px] font-medium text-[#0A0A0A]">SMTP password</label>
              <div className="flex gap-2">
                <input
                  id="smtp-password"
                  type="password"
                  value={smtpPassword}
                  onChange={e => setSmtpPassword(e.target.value)}
                  className={cx(B.input, 'flex-1 min-w-0')}
                  placeholder="••••••••"
                />
                <SecretRemoveButton
                  configKey="smtpPassword"
                  label="SMTP password"
                  hasValue={smtpPassword.length > 0}
                  onRemoved={() => setSmtpPassword('')}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField label="From address">
                <input
                  type="email"
                  value={smtpFromAddress}
                  onChange={e => setSmtpFromAddress(e.target.value)}
                  className={cx(B.input, 'w-full')}
                  placeholder="noreply@example.com"
                />
              </FormField>
              <FormField label="From name">
                <input
                  type="text"
                  value={smtpFromName}
                  onChange={e => setSmtpFromName(e.target.value)}
                  className={cx(B.input, 'w-full')}
                  placeholder="Frontier Command Centre"
                />
              </FormField>
            </div>
          </div>
          <div className="px-4 py-3 border-t border-[#F2F2F2]">
            <button
              type="button"
              onClick={handleSaveSmtp}
              disabled={savingSmtp}
              className={B.primary}
            >
              {savingSmtp ? 'Saving...' : 'Save SMTP settings'}
            </button>
          </div>
        </Panel>

      </PageBody>
    </>
  );
}

/* ── Page-local parts ──────────────────────────────────────────────── */

const CHECKBOX = 'h-3.5 w-3.5 rounded-[6px] border-[#DADADA] accent-[#0A0A0A] cursor-pointer';
const ROW_LINK = 'text-[13px] font-medium text-[#245BF3] hover:underline';
const DANGER_SOLID = 'inline-flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[10px] bg-[#B42318] text-white hover:bg-[#912018] disabled:opacity-50 disabled:cursor-not-allowed';

/** Test button: outline when idle, tinted green/red after a result. */
function testButtonClass(status: TestStatus): string {
  const base = 'inline-flex items-center justify-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-[10px] border whitespace-nowrap disabled:cursor-not-allowed';
  if (status === 'success') return cx(base, 'border-[#B7E4C7] bg-[#F1FBF4] text-[#14532D]');
  if (status === 'error') return cx(base, 'border-[#F3C0BB] bg-[#FFF5F4] text-[#B42318]');
  if (status === 'testing') return cx(base, 'border-[#DADADA] bg-[#FAFAFA] text-[#666666]');
  return cx(base, 'border-[#DADADA] bg-white text-[#0A0A0A] hover:bg-[#FAFAFA]');
}

const ROLE_LABEL: Record<AdminUser['role'], string> = {
  admin: 'Admin',
  manager: 'Manager',
  viewer: 'Viewer',
  cowork: 'Work Pulse',
  code: 'Developer Pulse',
  pulse: 'Pulse',
};

function RolePill({ role }: { role: AdminUser['role'] }) {
  return <Pill tone={role === 'admin' ? 'info' : 'neutral'}>{ROLE_LABEL[role] ?? 'Viewer'}</Pill>;
}

/** Form field: label above the control, optional 12px grey hint below. */
function FormField({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[14px] font-medium text-[#0A0A0A] min-w-0">
      {/* One element, so text plus a required-field star stays on one line. */}
      <span>{label}</span>
      <span className="font-normal">{children}</span>
      {hint && <span className="text-[13px] font-normal text-[#8F8F8F] leading-5">{hint}</span>}
    </label>
  );
}

/** On/off switch: black when on, #DADADA when off. */
function Switch({ checked, onChange, label, title, disabled }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-[34px] shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#245BF3]/30 disabled:opacity-50 disabled:cursor-not-allowed',
        checked ? 'bg-[#0A0A0A]' : 'bg-[#DADADA]',
      )}
    >
      <span
        aria-hidden="true"
        className={cx('absolute top-[3px] h-3.5 w-3.5 rounded-full bg-white transition-[left]', checked ? 'left-[17px]' : 'left-[3px]')}
      />
    </button>
  );
}

/** Modal: white, 1px #EAEAEA border, 10px corners, translucent ink backdrop. */
function Modal({ title, subtitle, labelId, wide = false, children }: {
  title: ReactNode;
  subtitle?: ReactNode;
  labelId: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-[rgba(10,10,10,0.25)] flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        className={cx('bg-white border border-[#EAEAEA] rounded-[16px] w-full', wide ? 'max-w-md' : 'max-w-sm')}
      >
        <div className="px-4 py-3 border-b border-[#EAEAEA]">
          <h3 id={labelId} className="m-0 text-[14px] font-semibold text-[#0A0A0A]">{title}</h3>
          {subtitle && <p className="m-0 mt-0.5 text-[13px] text-[#8F8F8F]">{subtitle}</p>}
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function ApiKeyField({
  label,
  value,
  onChange,
  hint,
  testStatus = 'idle',
  onTest,
  configKey,
  resetsNote,
  onRemoved,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint: string;
  testStatus?: TestStatus;
  onTest: () => void;
  configKey?: string;
  resetsNote?: string;
  onRemoved?: () => void;
}) {
  const inputId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-[14px] font-medium text-[#0A0A0A]">{label}</label>
      <div className="flex gap-2">
          <input
            id={inputId}
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            className={cx(B.input, 'flex-1 min-w-0 font-mono')}
            placeholder="sk-ant-..."
          />
          <button
            type="button"
            onClick={onTest}
            disabled={testStatus === 'testing'}
            className={testButtonClass(testStatus)}
          >
            {testStatus === 'testing' ? (
              <span className="flex items-center gap-1">
                <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Testing
              </span>
            ) : testStatus === 'success' ? (
              'Connected'
            ) : testStatus === 'error' ? (
              'Failed'
            ) : (
              'Test'
            )}
          </button>
          {configKey && onRemoved && (
            <SecretRemoveButton
              configKey={configKey}
              label={label}
              hasValue={value.length > 0}
              resetsNote={resetsNote}
              onRemoved={onRemoved}
            />
          )}
      </div>
      <span className="text-[13px] text-[#8F8F8F] leading-5">{hint}</span>
    </div>
  );
}
