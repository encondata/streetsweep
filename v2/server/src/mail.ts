// Outgoing email. Development sends to Mailpit (compose.yaml), which catches everything.
import nodemailer from "nodemailer";
import { config } from "./config.js";
import { HttpError } from "./http.js";

const transport = nodemailer.createTransport({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpSecure,
  auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
});

export async function sendMail(to: string, subject: string, text: string, html: string) {
  try {
    await transport.sendMail({ from: config.mailFrom, to, subject, text, html });
  } catch (err) {
    console.error("mail send failed:", (err as Error).message);
    throw new HttpError(503, "We couldn't send the email just now. Try again in a minute.");
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A plain, light, brand-coloured message with the code front and centre. */
export function codeEmail(o: { name: string; lead: string; code: string; after: string }) {
  const text = `Hi ${o.name},\n\n${o.lead}\n\n    ${o.code}\n\n${o.after}\n\nIt works once and expires in 15 minutes. If this wasn't you, you can ignore this email.\n\n— StreetSweep`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0d1b28">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #dde4ec;border-radius:14px">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:800;letter-spacing:-.02em">Street<span style="color:#1e8a28">Sweep</span></td></tr>
<tr><td style="padding:8px 28px;font-size:15px;line-height:1.5">Hi ${esc(o.name)},<br><br>${esc(o.lead)}</td></tr>
<tr><td align="center" style="padding:18px 28px">
<div style="display:inline-block;font:700 32px/1 ui-monospace,Menlo,monospace;letter-spacing:.3em;padding:16px 22px 16px 28px;background:#e5f4e4;color:#14701f;border-radius:12px">${esc(o.code)}</div>
</td></tr>
<tr><td style="padding:0 28px 8px;font-size:15px;line-height:1.5">${esc(o.after)}</td></tr>
<tr><td style="padding:12px 28px 28px;font-size:12.5px;line-height:1.5;color:#5a6a78">It works once and expires in 15 minutes. If this wasn't you, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

/** A plain message with no code: notices about requests and accounts. */
export function noticeEmail(o: { name: string; paragraphs: string[] }) {
  const text = `Hi ${o.name},\n\n${o.paragraphs.join("\n\n")}\n\n— StreetSweep`;
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0d1b28">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #dde4ec;border-radius:14px">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:800;letter-spacing:-.02em">Street<span style="color:#1e8a28">Sweep</span></td></tr>
<tr><td style="padding:8px 28px 28px;font-size:15px;line-height:1.5">Hi ${esc(o.name)},${o.paragraphs.map((p) => `<br><br>${esc(p)}`).join("")}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}
