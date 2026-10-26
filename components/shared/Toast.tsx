// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect } from 'react';

interface ToastProps {
  message: string;
  type: 'success' | 'error' | 'info';
  onClose: () => void;
}

export function Toast({ message, type, onClose }: ToastProps) {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const colors = {
    success: 'bg-white border-[#EAEAEA] border-l-[3px] border-l-[#1A7F37] text-[#0A0A0A]',
    error: 'bg-white border-[#EAEAEA] border-l-[3px] border-l-[#D92D20] text-[#0A0A0A]',
    info: 'bg-white border-[#EAEAEA] border-l-[3px] border-l-[#245BF3] text-[#0A0A0A]',
  };

  return (
    <div className={`fixed bottom-20 lg:bottom-4 right-4 z-50 px-4 py-3 rounded-[14px] border shadow-[0_8px_24px_rgba(10,10,10,0.10)] text-[14px] ${colors[type]}`}>
      {message}
    </div>
  );
}
