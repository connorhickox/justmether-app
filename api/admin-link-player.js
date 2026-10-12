// Commissioner-only: links a real email to an existing (historical, no-login-yet)
// player profile, so their point totals and pick history carry forward once they
// log in. Sends Supabase's own invite email -- the player sets their own password,
// we never see or choose it.
//
// Usage: POST { "name": "504Cheetah", "email": "friend@example.com" }
// Auth:  same bearer secret as the cron job (CRON_SECRET).

const { createClient } = require("@supabase/supabase-js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }
  if (process.env.CRON_SECRET) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + process.env.CRON_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  var name = req.body && req.body.name;
  var email = req.body && req.body.email;
  if (!name || !email) {
    return res.status(400).json({ error: "body must include { name, email }" });
  }

  try {
    var sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    var findRes = await sb.from("profiles").select("id,auth_user_id").eq("name", name).maybeSingle();
    if (findRes.error) throw findRes.error;
    if (!findRes.data) {
      return res.status(404).json({ error: "No profile found with name \"" + name + "\"" });
    }
    if (findRes.data.auth_user_id) {
      return res.status(409).json({ error: "\"" + name + "\" is already linked to an account" });
    }

    var inviteRes = await sb.auth.admin.inviteUserByEmail(email);
    if (inviteRes.error) throw inviteRes.error;
    var newUserId = inviteRes.data.user.id;

    var linkRes = await sb.from("profiles").update({ auth_user_id: newUserId }).eq("id", findRes.data.id);
    if (linkRes.error) throw linkRes.error;

    return res.status(200).json({ ok: true, name: name, email: email, auth_user_id: newUserId });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
