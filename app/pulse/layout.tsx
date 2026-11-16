// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

import { ReactNode } from 'react';
import { PulseRoleGuard } from '@/components/shared/PulseRoleGuard';

export default function PulseLayout({ children }: { children: ReactNode }) {
  return <><PulseRoleGuard />{children}</>;
}
