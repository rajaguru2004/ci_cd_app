import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import '@fontsource-variable/montserrat';
import './globals.css';

export const metadata: Metadata = {
  title: 'FusionHRM Android · Pipeline',
  description: 'Build, test and release the FusionHRM Android app to Google Play.',
};

export const viewport: Viewport = {
  themeColor: '#f4f6fc',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={GeistMono.variable}>
      <body>{children}</body>
    </html>
  );
}
