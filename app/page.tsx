'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Account { userId: string; tenantId: string; tier: string }

export default function Home() {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<Account>('/account').then(setAccount).catch((caught) => setError(caught instanceof Error ? caught.message : 'Request failed'));
  }, []);
  return (
    <main className="mx-auto min-h-screen max-w-4xl p-8">
      <div className="mt-20">
        <p className="text-sm font-bold uppercase tracking-[.25em] text-emerald-400">Built with flowstacks.ai and Next.js</p>
        <h1 className="mt-3 text-6xl font-black tracking-tight">{"example-todo"}</h1>
        <p className="mt-4 max-w-2xl text-zinc-400">Static Next.js pages with Cognito-authenticated, tier-limited Route Handler Lambdas.</p>
      </div>
      {error && <p className="mt-10 text-rose-400">{error}</p>}
      {account && (
        <dl className="mt-10 grid gap-3 border border-zinc-800 bg-zinc-900/60 p-6 sm:grid-cols-3">
          <div><dt className="text-xs uppercase tracking-wider text-zinc-500">User</dt><dd className="mt-2 break-all">{account.userId}</dd></div>
          <div><dt className="text-xs uppercase tracking-wider text-zinc-500">Tenant</dt><dd className="mt-2 break-all">{account.tenantId}</dd></div>
          <div><dt className="text-xs uppercase tracking-wider text-zinc-500">Tier</dt><dd className="mt-2 capitalize">{account.tier}</dd></div>
        </dl>
      )}
    </main>
  );
}
