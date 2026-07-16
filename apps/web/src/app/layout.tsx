import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zygos',
  description: 'Position risk management for on-chain prediction markets, priced by TxLINE consensus odds.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-mono">{children}</body>
    </html>
  );
}
