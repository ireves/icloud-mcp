import 'dotenv/config';
import { listFolders, listMessages, getMessage } from '../lib/imap.js';

async function main() {
  console.log('--- list_folders ---');
  const folders = await listFolders();
  console.log(`Found ${folders.length} folders:`);
  for (const folder of folders) {
    console.log(`  ${folder.path} (${folder.flags.join(', ') || 'no flags'})`);
  }

  const inbox = folders.find((f) => f.specialUse === '\\Inbox') ?? folders.find((f) => f.path === 'INBOX');
  if (!inbox) {
    console.log('No INBOX-like folder found — stopping here.');
    return;
  }

  console.log(`\n--- list_messages (folder: ${inbox.path}, limit: 5) ---`);
  const messages = await listMessages({ folder: inbox.path, limit: 5 });
  console.log(`Found ${messages.length} messages:`);
  for (const message of messages) {
    console.log(`  uid=${message.uid} unread=${message.unread} "${message.subject}" from ${message.from}`);
  }

  if (messages.length > 0) {
    console.log(`\n--- get_message (uid: ${messages[0].uid}) ---`);
    const detail = await getMessage({ folder: inbox.path, uid: messages[0].uid });
    console.log(`Subject: ${detail.subject}`);
    console.log(`From: ${detail.from}`);
    console.log(`Body (first 200 chars): ${detail.body.slice(0, 200)}`);
  }

  console.log('\nIMAP smoke test complete.');
}

main().catch((error) => {
  console.error('IMAP smoke test failed:', error);
  process.exitCode = 1;
});
