import ConsentForm from './consent-form';

export const metadata = { title: 'Connect — iCloud MCP' };

export default function ConsentPage() {
  return (
    <main>
      <h1>Connect an assistant</h1>
      <ConsentForm />
    </main>
  );
}
