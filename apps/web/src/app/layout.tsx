import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Zygos Terminal',
  description: 'Position risk management for on-chain prediction markets, priced by TxLINE consensus odds.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistSans.variable} style={{ ['--font-geist' as string]: GeistSans.style.fontFamily }}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
