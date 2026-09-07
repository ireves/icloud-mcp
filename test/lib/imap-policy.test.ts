import { describe, expect, it, afterEach } from 'vitest';
import { assertMoveAllowed, type MailboxListEntry } from '../../lib/imap.js';

const INBOX: MailboxListEntry = { path: 'INBOX', name: 'INBOX' };
const TRASH_BY_FLAG: MailboxListEntry = { path: 'INBOX.Trash', name: 'Trash', specialUse: '\\Trash' };
const JUNK_BY_FLAG: MailboxListEntry = { path: 'INBOX.Junk', name: 'Junk', specialUse: '\\Junk' };
const JUNK_EMAIL_NO_FLAG: MailboxListEntry = { path: 'INBOX.Junk E-mail', name: 'Junk E-mail' };
const JUNK_RESEARCH_NO_FLAG: MailboxListEntry = { path: 'INBOX.Junk Research', name: 'Junk Research' };
const ARCHIVE: MailboxListEntry = { path: 'INBOX.Archive', name: 'Archive', specialUse: '\\Archive' };

describe('assertMoveAllowed', () => {
  const mailboxes = [INBOX, TRASH_BY_FLAG, JUNK_BY_FLAG, JUNK_EMAIL_NO_FLAG, JUNK_RESEARCH_NO_FLAG, ARCHIVE];

  afterEach(() => {
    delete process.env.ALLOW_TRASH_JUNK_MOVES;
  });

  it('allows a move to an ordinary folder', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Archive')).not.toThrow();
  });

  it('blocks a move to a folder with special-use \\Trash', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Trash')).toThrow(/blocked by default/);
  });

  it('blocks a move to a folder with special-use \\Junk', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Junk')).toThrow(/blocked by default/);
  });

  it('blocks a move to a folder with no special-use flag but an exact fallback name match', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Junk E-mail')).toThrow(/blocked by default/);
  });

  it('does not block a folder named "Junk Research" with no special-use flag (no substring matching)', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Junk Research')).not.toThrow();
  });

  it('rejects an unresolvable target folder', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.DoesNotExist')).toThrow(/does not exist/);
  });

  it('allows a recovery move out of Trash into an ordinary folder', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX.Trash', 'INBOX')).not.toThrow();
  });

  it('allows a recovery move out of Junk into an ordinary folder', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX.Junk', 'INBOX')).not.toThrow();
  });

  it('treats a move from one prohibited folder to another as still blocked (not a recovery)', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX.Trash', 'INBOX.Junk')).toThrow(/blocked by default/);
  });

  it('treats source equal to target as a no-op, even if that folder is Trash', () => {
    expect(() => assertMoveAllowed(mailboxes, 'INBOX.Trash', 'INBOX.Trash')).not.toThrow();
  });

  it('permits an otherwise-blocked move when ALLOW_TRASH_JUNK_MOVES=true', () => {
    process.env.ALLOW_TRASH_JUNK_MOVES = 'true';
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Trash')).not.toThrow();
  });

  it('still blocks when ALLOW_TRASH_JUNK_MOVES is set to anything other than the string "true"', () => {
    process.env.ALLOW_TRASH_JUNK_MOVES = '1';
    expect(() => assertMoveAllowed(mailboxes, 'INBOX', 'INBOX.Trash')).toThrow(/blocked by default/);
  });
});
