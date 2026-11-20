// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { BRIEFING_DEFAULT_MODEL } from '@/lib/anthropic/constants';
import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import TopBar from '@/components/layout/TopBar';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import OverviewTab from '@/components/pulse/admin/OverviewTab';
import DepartmentsTab from '@/components/pulse/admin/DepartmentsTab';
import UsersTab from '@/components/pulse/admin/UsersTab';
import TierConfigTab from '@/components/pulse/admin/TierConfigTab';
import HealthTab from '@/components/pulse/admin/HealthTab';
import AuditTab from '@/components/pulse/admin/AuditTab';
import HumanTimeChecks from '@/components/pulse/admin/HumanTimeChecks';
import { effectiveCodeHumanTime } from '@/lib/pulse/human-time';
import { PageBody, Tabs } from '@/components/precision/ui';
import { sharedGet } from '@/components/shared/shared-get';

type Tab = 'overview' | 'users' | 'depts' | 'tiers' | 'health' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview',  label: 'Overview' },
  { id: 'users',     label: 'Users' },
  { id: 'depts',     label: 'Departments' },
  { id: 'tiers',     label: 'Tier config' },
  { id: 'health',    label: 'Classifier health' },
  { id: 'audit',     label: 'Audit' },
];

interface ModuleConfig {
  pulseEnabled: string;
  pulseClassifierModel: string;
  pulseBriefingModel: string;
  /** '' = follow the Core AI model. */
  pulseUserBriefingModel: string;
  pulseSessionDescriptionsEnabled: string;
  pulseClassifyChatgpt: string;
  claudeInOfficeShown: string;
  humanTimeEnabled: string;
  /** Read-only here (set on Admin → Developer Pulse): the spot-check shows when either surface is on. */
  humanTimeCodeEnabled: string;
  /** Read-only here (set on Admin → System); shown so "follow" names a real model. */
  coreAiModel: string;
}

interface PulseStats {
  classifiedTotal: number;
  classifiedThisWeek: number;
  failedTotal: number;
  briefingsTotal: number;
  eventsTotal: number;
}

export default function AdminPulsePage() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const activeTab = (searchParams.get('tab') as Tab) ?? 'overview';

  const [userRole, setUserRole] = useState('');
  const [config, setConfig] = useState<ModuleConfig>({
    pulseEnabled: 'false',
    pulseClassifierModel: 'claude-haiku-5-5',
    pulseBriefingModel: BRIEFING_DEFAULT_MODEL,
    pulseUserBriefingModel: '',
    pulseSessionDescriptionsEnabled: 'true',
    pulseClassifyChatgpt: 'true',
    claudeInOfficeShown: 'true',
    humanTimeEnabled: 'false',
    humanTimeCodeEnabled: '',
    coreAiModel: '',
  });
  const [stats, setStats] = useState<PulseStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [, setPendingCount] = useState(0);

  useEffect(() => {
    sharedGet('/api/admin/session')
      .then(r => r.json())
      // A failed check still ends the wait, with the non-admin view.
      .then(data => setUserRole(data.authenticated ? (data.user?.role || 'unknown') : 'unknown'))
      .catch(() => setUserRole('unknown'));
  }, []);

  useEffect(() => {
    Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/pulse/admin/stats').then(r => r.json()).catch(() => null),
    ]).then(([configData, statsData]) => {
      setConfig({
        pulseEnabled: String(configData.pulseEnabled ?? 'false'),
        pulseClassifierModel: String(configData.pulseClassifierModel ?? 'claude-haiku-5-5'),
        pulseBriefingModel: String(configData.pulseBriefingModel ?? BRIEFING_DEFAULT_MODEL),
        pulseUserBriefingModel: String(configData.pulseUserBriefingModel ?? ''),
        pulseSessionDescriptionsEnabled: String(configData.pulseSessionDescriptionsEnabled ?? 'true'),
        pulseClassifyChatgpt: String(configData.pulseClassifyChatgpt ?? 'true'),
        claudeInOfficeShown: String(configData.claudeInOfficeShown ?? 'true'),
        humanTimeEnabled: String(configData.humanTimeEnabled ?? 'false'),
        humanTimeCodeEnabled: String(configData.humanTimeCodeEnabled ?? ''),
        coreAiModel: String(configData.coreAiModel ?? ''),
      });
      if (statsData) setStats(statsData);
    }).finally(() => setLoading(false));
  }, []);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pulseEnabled: config.pulseEnabled,
          pulseClassifierModel: config.pulseClassifierModel,
          pulseBriefingModel: config.pulseBriefingModel,
          pulseUserBriefingModel: config.pulseUserBriefingModel,
          pulseSessionDescriptionsEnabled: config.pulseSessionDescriptionsEnabled,
          pulseClassifyChatgpt: config.pulseClassifyChatgpt,
          claudeInOfficeShown: config.claudeInOfficeShown,
          humanTimeEnabled: config.humanTimeEnabled,
        }),
      });
      if (!res.ok) throw new Error('save failed');
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch {
      setSaveMsg("Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }, [config]);

  const setTab = (tab: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', tab);
    router.push(`/admin/pulse?${params.toString()}`);
  };

  const visibleTabs = TABS.filter(tab => {
    if (tab.id === 'tiers' || tab.id === 'health' || tab.id === 'audit') return userRole === 'admin';
    return true;
  });

  useEffect(() => {
    if (userRole && userRole !== 'admin' && (activeTab === 'tiers' || activeTab === 'health' || activeTab === 'audit')) {
      setTab('overview');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userRole, activeTab]);

  // Wait for the role too: the Overview tab loads admin-only parts only for an admin.
  if (loading || !userRole) return (
    <>
      <TopBar title="Work Pulse admin" subtitle="Configuration, drill-downs, tier settings, and classifier health" />
      <LoadingSpinner />
    </>
  );

  return (
    <>
      <TopBar title="Work Pulse admin" subtitle="Configuration, drill-downs, tier settings, and classifier health" />
      <PageBody>

        {/* Tab bar */}
        <Tabs<Tab>
          label="Work Pulse admin"
          tabs={visibleTabs.map(tab => ({ value: tab.id, label: tab.label }))}
          value={activeTab}
          onChange={setTab}
        />

        {/* Tab content */}
        {activeTab === 'overview' && (
          <OverviewTab
            config={config}
            stats={stats}
            saving={saving}
            saveMsg={saveMsg}
            onSave={saveConfig}
            onConfigChange={patch => setConfig(c => ({ ...c, ...patch }))}
            onPendingCountChange={setPendingCount}
            isAdmin={userRole === 'admin'}
          />
        )}

        {activeTab === 'users' && <UsersTab />}

        {activeTab === 'depts' && <DepartmentsTab />}

        {activeTab === 'tiers' && <TierConfigTab />}

        {activeTab === 'health' && <HealthTab />}

        {activeTab === 'audit' && <AuditTab />}
        {activeTab === 'audit' && (config.humanTimeEnabled === 'true' || effectiveCodeHumanTime(config.humanTimeCodeEnabled, config.humanTimeEnabled)) && <HumanTimeChecks />}

      </PageBody>
    </>
  );
}
