export interface MailboxInfo {
  path: string;
  name: string;
  flags: string[];
  specialUse?: string;
}

export interface MessageSummary {
  uid: number;
  subject: string;
  from: string;
  date: string;
  unread: boolean;
}

export interface MessageDetail extends MessageSummary {
  to: string;
  body: string;
}

export interface CalendarInfo {
  id: string;
  name: string;
  color?: string;
}

export interface EventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  hasAttendees: boolean;
}

export interface EventDetail extends EventSummary {
  notes?: string;
}

export interface ReminderListInfo {
  id: string;
  name: string;
}

export interface ReminderSummary {
  id: string;
  title: string;
  dueDate?: string;
  completed: boolean;
}

export interface ReminderDetail extends ReminderSummary {
  notes?: string;
}
