import { ImapFlow } from "imapflow";
import { postCommMessage, isProcessed, markProcessed, hasTodosFromMessage } from "../household/comms-bus.js";
import { extractActions } from "./action-extractor.js";
import { log } from "../lib/log.js";
const ACCOUNTS = [
  { label: "homerepair", entity: "homerepair", user: "daniel@homerepair.tech", password: process.env.PRIVATEEMAIL_PASSWORD ?? "", host: "mail.privateemail.com", port: 993 },
  { label: "thewatsonfactor", entity: "watson_factor", user: "thewatsonfactor@gmail.com", password: (process.env.GMAIL_APP_thewatsonfactor ?? "").replace(/\s/g,""), host: "imap.gmail.com", port: 993 },
  { label: "watsoncontentcreation", entity: "content", user: "watsoncontentcreation@gmail.com", password: (process.env.GMAIL_APP_watsoncontentcreation ?? "").replace(/\s/g,""), host: "imap.gmail.com", port: 993 },
  { label: "turnkeytexas", entity: "personal", user: "turnkeytexas@gmail.com", password: (process.env.GMAIL_APP_turnkeytexas ?? "").replace(/\s/g,""), host: "imap.gmail.com", port: 993 },
  { label: "novarabuildgroup", entity: "novara", user: "novarabuildgroup@gmail.com", password: (process.env.GMAIL_APP_novarabuildgroup ?? "").replace(/\s/g,""), host: "imap.gmail.com", port: 993 },
  { label: "turnkeytexas-icloud", entity: "personal", user: "turnkeytexas@icloud.com", password: (process.env.ICLOUD_APP_turnkeytexas ?? "").replace(/\s/g,""), host: "imap.mail.me.com", port: 993 },
];
// Accounts whose poll is still running; a slow inbox is skipped rather than
// polled twice at once.
const inFlight = new Set<string>();

async function pollAccount(account: typeof ACCOUNTS[0]) {
  if (!account.password) return;
  if (inFlight.has(account.label)) return;
  inFlight.add(account.label);
  const client = new ImapFlow({ host: account.host, port: account.port, secure: true, auth: { user: account.user, pass: account.password }, logger: false });
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const messages = client.fetch({ seen: false, since }, { envelope: true, source: true });
      let count = 0;
      for await (const msg of messages) {
        try {
          const from = msg.envelope?.from?.[0]?.address ?? "";
          const subject = msg.envelope?.subject ?? "(no subject)";
          const date = msg.envelope?.date?.toISOString() ?? new Date().toISOString();
          const msgId = msg.envelope?.messageId ?? `${account.user}-${msg.uid}`;
          if (await isProcessed(msgId)) continue;
          let body = "";
          if (msg.source) { const parts = msg.source.toString().split(/\r?\n\r?\n/); if (parts.length > 1) body = parts.slice(1).join("\n").slice(0, 1000); }
          await postCommMessage({ source: "gmail", entity: account.entity, from, subject, body, date, msgId, read: false, needsReply: false });
          // Second guard: even if the ledger is lost, never send the same email
          // to Claude twice once it has produced todos.
          if (body.length > 50 && !(await hasTodosFromMessage(msgId))) {
            await extractActions(`Email from ${from}: ${subject}\n\n${body}`, account.entity, "email", msgId);
          }
          await markProcessed(msgId);
          count++;
        } catch (e) { log("error", "imap", String(e)); }
      }
      if (count > 0) log("ok", "imap", `${account.label}: ${count} new`);
    } finally { lock.release(); }
    await client.logout();
  } catch (e) { log("error", "imap", `${account.label}: ${String(e)}`); }
  finally { inFlight.delete(account.label); }
}
export function startImapWatcher() {
  log("info", "imap", `starting watcher for ${ACCOUNTS.length} accounts`);
  Promise.allSettled(ACCOUNTS.map(pollAccount));
  setInterval(() => Promise.allSettled(ACCOUNTS.map(pollAccount)), 5 * 60 * 1000);
}
