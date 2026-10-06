import SettingsForm from './settings-form';

export const metadata = { title: 'Settings — iCloud MCP' };

export default function SettingsPage() {
  return (
    <main>
      <h1>Settings</h1>
      <SettingsForm />
    </main>
  );
}
