// Copyright 2026 Lee James
// SPDX-License-Identifier: Apache-2.0

export default function LoadingSpinner({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center py-12 ${className}`}>
      <div className="w-5 h-5 border-2 border-[#EAEAEA] border-t-[#0A0A0A] rounded-full animate-spin" role="status" aria-label="Loading" />
    </div>
  );
}
