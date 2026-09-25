import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * This server must never be able to send email. It only speaks IMAP, which
 * stores messages and has no command for sending one; sending needs an SMTP
 * connection. These checks fail the build if any code that could open one,
 * or any library for sending mail, finds its way into the project.
 */

const ROOT = join(__dirname, '..', '..');
const SOURCE_DIRS = ['app', 'lib', 'tools', 'scripts'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(name) ? [path] : [];
  });
}

const files = [...SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))), join(ROOT, 'next.config.mjs')];

function importsIn(source: string): string[] {
  const found = [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)];
  return found.map((match) => match[1]);
}

describe('the server cannot send email', () => {
  it('finds the source files it is checking', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('only uses the part of nodemailer that builds a message', () => {
    const offending = files.flatMap((file) =>
      importsIn(readFileSync(file, 'utf8'))
        .filter((spec) => spec.startsWith('nodemailer'))
        .filter((spec) => spec !== 'nodemailer/lib/mail-composer/index.js')
        .map((spec) => `${relative(ROOT, file)}: ${spec}`),
    );
    expect(offending).toEqual([]);
  });

  it('never opens a raw network connection of its own', () => {
    const offending = files.flatMap((file) =>
      importsIn(readFileSync(file, 'utf8'))
        .filter((spec) => /^(node:)?(net|tls|dgram|child_process)$/.test(spec))
        .map((spec) => `${relative(ROOT, file)}: ${spec}`),
    );
    expect(offending).toEqual([]);
  });

  it('never mentions SMTP, a mail transport or sending a message', () => {
    const offending = files.filter((file) =>
      /smtp|createTransport|sendMail|submission|:587\b|:465\b/i.test(readFileSync(file, 'utf8')),
    );
    expect(offending.map((file) => relative(ROOT, file))).toEqual([]);
  });

  it('connects only to the IMAP server for mail', () => {
    const hosts = files.flatMap((file) => readFileSync(file, 'utf8').match(/[a-z0-9.-]*mail\.me\.com/gi) ?? []);
    expect(new Set(hosts)).toEqual(new Set(['imap.mail.me.com']));
  });

  it('depends on no library whose job is sending mail', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const senders = names.filter((name) =>
      /smtp|sendgrid|mailgun|postmark|resend|sparkpost|mailjet|(^|[/-])ses($|[/-])|mandrill|emailjs|sendmail/i.test(name),
    );
    expect(senders).toEqual([]);
  });
});
