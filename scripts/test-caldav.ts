import 'dotenv/config';
import { listCalendars, listEvents, listReminderLists, listReminders } from '../lib/caldav.js';

async function main() {
  console.log('--- list_calendars ---');
  const calendars = await listCalendars();
  console.log(`Found ${calendars.length} calendars:`);
  for (const cal of calendars) {
    console.log(`  ${cal.id} — ${cal.name}`);
  }

  if (calendars.length > 0) {
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    console.log(`\n--- list_events (calendar: ${calendars[0].name}, next 30 days) ---`);
    const events = await listEvents({
      calendarId: calendars[0].id,
      startDate: now.toISOString(),
      endDate: in30Days.toISOString(),
    });
    console.log(`Found ${events.length} events:`);
    for (const event of events) {
      console.log(`  "${event.title}" ${event.start} - ${event.end}`);
    }
  }

  console.log('\n--- list_reminder_lists ---');
  const lists = await listReminderLists();
  console.log(`Found ${lists.length} reminder lists:`);
  for (const list of lists) {
    console.log(`  ${list.id} — ${list.name}`);
  }

  if (lists.length > 0) {
    console.log(`\n--- list_reminders (list: ${lists[0].name}) ---`);
    const reminders = await listReminders({ listId: lists[0].id });
    console.log(`Found ${reminders.length} open reminders:`);
    for (const reminder of reminders) {
      console.log(`  "${reminder.title}" due=${reminder.dueDate ?? 'none'}`);
    }
  }

  console.log('\nCalDAV smoke test complete.');
}

main().catch((error) => {
  console.error('CalDAV smoke test failed:', error);
  process.exitCode = 1;
});
