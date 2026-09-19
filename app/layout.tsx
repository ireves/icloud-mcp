import type { ReactNode } from 'react';

export const metadata = {
  title: 'iCloud MCP',
  description: 'Private remote MCP server for iCloud mail, calendar and reminders.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body
        style={{
          fontFamily: 'system-ui, -apple-system, sans-serif',
          maxWidth: '32rem',
          margin: '4rem auto',
          padding: '0 1rem',
          color: '#1a1a1a',
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
