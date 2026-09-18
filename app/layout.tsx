import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthGate, AuthProvider } from './auth';
import './globals.css';

export const metadata: Metadata = {
  title: "example-todo",
  description: 'Built with flowstacks.ai',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AuthGate>{children}</AuthGate>
        </AuthProvider>
      </body>
    </html>
  );
}
