// Deleting an account (/delete-me): signed in, you delete your own with your password.
// Signed out, you confirm your address with an emailed code and a site admin carries
// the request out. Admins can also delete an account straight from the Users list.
import type { FastifyInstance } from "fastify";
import { pool, query, tx } from "../db.js";
import { clearFailures, endSession, noteFailure, requireSiteAdmin, requireUser, tooManyFailures, verifyPassword } from "../auth.js";
import { audit } from "../audit.js";
import { CODE_MINUTES, issueCode, sendOrForget, useCode } from "../codes.js";
import { codeEmail, noticeEmail, sendMail } from "../mail.js";
import { deleteAccount } from "../deletion.js";
import { HttpError, badRequest, conflict, notFound } from "../http.js";

const email = { type: "string", maxLength: 254 } as const;

/** Tell the person, without failing the request if mail is down. */
async function tell(to: string, name: string, subject: string, paragraphs: string[]) {
  const m = noticeEmail({ name, paragraphs });
  await sendMail(to, subject, m.text, m.html).catch(() => {});
}

export default async function deletionRoutes(app: FastifyInstance) {
  // Signed in: delete your own account now. The password is asked again.
  app.post<{ Body: { password: string } }>(
    "/api/me/delete",
    { schema: { body: { type: "object", required: ["password"], properties: { password: { type: "string", maxLength: 200 } } } } },
    async (req, reply) => {
      const me = requireUser(req);
      const key = `delete:${me.id}`;
      if (tooManyFailures(key)) throw new HttpError(429, "Too many wrong passwords. Wait a while, then try again.");
      const { rows } = await query<{ password_hash: string; email: string; display_name: string }>(
        `SELECT password_hash, email, display_name FROM users WHERE id = $1`, [me.id],
      );
      if (!(await verifyPassword(req.body.password, rows[0].password_hash))) {
        noteFailure(key);
        throw badRequest("That password isn't right.");
      }
      clearFailures(key);
      await deleteAccount(me.id, { userId: me.id, via: "self" });
      await endSession(req, reply);
      await tell(rows[0].email, rows[0].display_name, "Your StreetSweep account has been deleted", [
        "Your StreetSweep account and its data have been deleted, as you asked.",
        "If you didn't do this, reply to this email straight away.",
      ]);
      return { ok: true };
    },
  );

  // Signed out, step 1: email a code to prove the address. Same answer for unknown addresses.
  app.post<{ Body: { email: string } }>(
    "/api/deletion-requests",
    { schema: { body: { type: "object", required: ["email"], properties: { email } } } },
    async (req) => {
      const { rows } = await query<{ id: string; display_name: string; email: string }>(
        `SELECT id, display_name, email FROM users WHERE email = $1`, [req.body.email.trim()],
      );
      const u = rows[0];
      if (u) {
        const code = await issueCode(pool, u.id, "delete");
        const m = codeEmail({ name: u.display_name, code,
          lead: "Someone (hopefully you) asked for your StreetSweep account to be deleted. To confirm the request, enter this code:",
          after: "Once confirmed, an administrator deletes your account and all its data, usually within a few days and always within 30. We'll email you when it's done." });
        await sendOrForget(u.id, "delete", () => sendMail(u.email, `${code} is your StreetSweep deletion code`, m.text, m.html));
      }
      return { ok: true, expires_in: CODE_MINUTES * 60 };
    },
  );

  // Signed out, step 2: the code confirms the request, which joins the admins' queue.
  app.post<{ Body: { email: string; code: string; reason?: string } }>(
    "/api/deletion-requests/confirm",
    { schema: { body: { type: "object", required: ["email", "code"],
        properties: { email, code: { type: "string", maxLength: 20 }, reason: { type: "string", maxLength: 1000 } } } } },
    async (req) => {
      const { rows } = await query<{ id: string; display_name: string; email: string }>(
        `SELECT id, display_name, email FROM users WHERE email = $1`, [req.body.email.trim()],
      );
      const u = rows[0];
      if (!u) throw new HttpError(400, "That code has expired. Send yourself a new one.", "expired");
      const result = await tx(async (db) => {
        const check = await useCode(db, u.id, "delete", req.body.code);
        if (!check.ok) return check;
        const reason = req.body.reason?.trim() || null;
        const made = await db.query(
          `INSERT INTO deletion_requests (email, display_name, user_id, reason) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING RETURNING id`,
          [u.email, u.display_name, u.id, reason],
        );
        if (made.rows[0]) await audit(db, { userId: u.id, action: "user.deletion_requested", entity: "deletion_request", entityId: made.rows[0].id });
        return { ok: true as const, isNew: !!made.rows[0] };
      });
      if (!result.ok) throw result.error;
      if (result.isNew) {
        const admins = await query<{ email: string; display_name: string }>(
          `SELECT email, display_name FROM users WHERE is_site_admin AND disabled_at IS NULL`,
        );
        for (const a of admins.rows) {
          await tell(a.email, a.display_name, "Account deletion request", [
            `${u.display_name} (${u.email}) has asked for their StreetSweep account to be deleted, and confirmed their email address.`,
            "Open Admin → Deletion requests on StreetSweep to carry it out. The privacy policy promises it within 30 days.",
          ]);
        }
      }
      return { ok: true };
    },
  );

  // ---- site admins ---------------------------------------------------------------

  app.get("/api/admin/deletion-requests", async (req) => {
    requireSiteAdmin(req);
    const { rows } = await query(
      `SELECT r.id, r.email, r.display_name, r.user_id, r.reason, r.status, r.requested_at, r.decided_at, r.note,
              d.display_name AS decided_by_name
         FROM deletion_requests r LEFT JOIN users d ON d.id = r.decided_by
        ORDER BY r.status = 'pending' DESC, r.requested_at DESC LIMIT 200`,
    );
    return { requests: rows };
  });

  app.post<{ Params: { id: string } }>("/api/admin/deletion-requests/:id/complete", async (req) => {
    const me = requireSiteAdmin(req);
    const { rows } = await query<{ user_id: string | null; email: string; display_name: string; status: string }>(
      `SELECT user_id, email, display_name, status FROM deletion_requests WHERE id = $1`, [req.params.id],
    );
    const r = rows[0];
    if (!r) throw notFound("That request doesn't exist.");
    if (r.status !== "pending") throw conflict("That request has already been dealt with.");
    if (r.user_id === me.id) throw conflict("That's your own account. Delete it at /delete-me instead.");
    if (r.user_id) await deleteAccount(r.user_id, { userId: me.id, via: "admin" });
    // Deleting the account closes its pending request; one whose account was already gone closes here.
    await query(`UPDATE deletion_requests SET status = 'done', decided_at = now(), decided_by = $2
                  WHERE id = $1 AND status = 'pending'`, [req.params.id, me.id]);
    await tell(r.email, r.display_name, "Your StreetSweep account has been deleted", [
      "As you asked, your StreetSweep account and its data have been deleted.",
      "Thanks for driving with us.",
    ]);
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { note?: string } }>(
    "/api/admin/deletion-requests/:id/decline",
    { schema: { body: { type: "object", properties: { note: { type: "string", maxLength: 1000 } } } } },
    async (req) => {
      const me = requireSiteAdmin(req);
      const note = req.body?.note?.trim() || null;
      const { rows } = await query<{ email: string; display_name: string }>(
        `UPDATE deletion_requests SET status = 'declined', decided_at = now(), decided_by = $2, note = $3
          WHERE id = $1 AND status = 'pending' RETURNING email, display_name`, [req.params.id, me.id, note],
      );
      if (!rows[0]) throw conflict("That request has already been dealt with.");
      await audit(pool, { userId: me.id, action: "user.deletion_declined", entity: "deletion_request", entityId: req.params.id });
      await tell(rows[0].email, rows[0].display_name, "About your StreetSweep deletion request", [
        "We haven't deleted your StreetSweep account yet." + (note ? ` ${note}` : ""),
        "Reply to this email if you have questions, or ask again at streetsweep.net/delete-me.",
      ]);
      return { ok: true };
    },
  );

  // Straight from the Users list, with no request.
  app.delete<{ Params: { id: string } }>("/api/admin/users/:id", async (req) => {
    const me = requireSiteAdmin(req);
    if (req.params.id === me.id) throw conflict("That's your own account. Delete it at /delete-me instead.");
    await deleteAccount(req.params.id, { userId: me.id, via: "admin" });
    return { ok: true };
  });
}
