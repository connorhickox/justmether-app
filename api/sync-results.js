// Weekly sync job: mirrors fantasysurvivor.net's own Tribal Commissioner data
// (results.asp + picks.asp) into our Supabase database, so the commissioner
// never has to publish anything by hand.
//
// Triggered by Vercel Cron (see vercel.json) three times every Thursday to
// bracket noon Central across both EST/EDT and the Nov-DST switch. The sync
// itself is idempotent -- it just mirrors whatever fantasysurvivor.net is
// currently showing, so extra/early/late runs are harmless no-ops.

const { createClient } = require("@supabase/supabase-js");
const cheerio = require("cheerio");

const SITE = "http://fantasysurvivor.net";

function getTZOffsetMinutes(timeZone, utcMillis) {
  var dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  var map = {};
  dtf.formatToParts(new Date(utcMillis)).forEach(function (p) { map[p.type] = p.value; });
  var asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return (asUTC - utcMillis) / 60000;
}

// "10/14/2026 7:55:00 PM" in America/New_York (the site's displayed "ET") -> UTC ISO string.
function etStringToUtcISO(dateStr) {
  var m = dateStr.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  var mo = +m[1], da = +m[2], yr = +m[3], hh = +m[4], mi = +m[5], ss = +m[6], ap = m[7].toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  var naiveUTC = Date.UTC(yr, mo - 1, da, hh, mi, ss);
  var offsetMin = getTZOffsetMinutes("America/New_York", naiveUTC);
  return new Date(naiveUTC - offsetMin * 60000).toISOString();
}

// Tiny manual cookie jar -- plain fetch() has no cookie store of its own.
function CookieJar() { this.jar = {}; }
CookieJar.prototype.capture = function (res) {
  var jar = this.jar;
  var raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  if (!raw || !raw.length) {
    var single = res.headers.get("set-cookie");
    raw = single ? [single] : [];
  }
  raw.forEach(function (line) {
    var kv = line.split(";")[0];
    var eq = kv.indexOf("=");
    if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  });
};
CookieJar.prototype.header = function () {
  var jar = this.jar;
  return Object.keys(jar).map(function (k) { return k + "=" + jar[k]; }).join("; ");
};

async function siteLogin(jar, email, password) {
  var getRes = await fetch(SITE + "/logon.asp");
  jar.capture(getRes);
  var html = await getRes.text();
  var $ = cheerio.load(html);
  var cookieValue = $('input[name="CookieValue"]').attr("value") || "";

  var body = new URLSearchParams({
    CookieValue: cookieValue,
    EMAIL_ADDR: email,
    PASSWORD: password,
    STAY_LOGGED_ON: "True",
    SubmitButton: "Logon",
  });

  var postRes = await fetch(SITE + "/logon.asp", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jar.header(),
    },
    body: body.toString(),
    redirect: "manual",
  });
  jar.capture(postRes);

  // Classic-ASP sometimes 302-redirects to game/default.asp, sometimes renders
  // it in a 200. Either way, verify by content rather than trusting the status:
  // a logged-in page.asp won't have the logon form on it.
  var checkRes = await fetch(SITE + "/game/default.asp", { headers: { Cookie: jar.header() } });
  jar.capture(checkRes);
  var checkHtml = await checkRes.text();
  if (/name="EMAIL_ADDR"/.test(checkHtml)) {
    throw new Error("Still seeing the logon form after POSTing credentials -- login failed.");
  }
}

async function siteGet(jar, path) {
  var res = await fetch(SITE + path, { headers: { Cookie: jar.header() } });
  jar.capture(res);
  var html = await res.text();
  if (/name="EMAIL_ADDR"/.test(html)) {
    throw new Error("Got the logon form back from " + path + " -- session cookie not accepted.");
  }
  return html;
}

// Parse results.asp: returns {episodeNum, results: {reward, immunity, votedOff, mystery}}
function parseResultsPage(html) {
  var $ = cheerio.load(html);
  var headerText = $(".PAGEHEADER").first().text();
  var epMatch = headerText.match(/Episode\s+(\d+)/i);
  if (!epMatch) throw new Error("Could not find episode number on results.asp (header: \"" + headerText + "\")");
  var episodeNum = parseInt(epMatch[1], 10);

  var wanted = { "Reward": "reward", "Immunity": "immunity", "Voted Off": "votedOff", "Mystery": "mystery" };
  var results = { reward: [], immunity: [], votedOff: [], mystery: [] };

  $("table tr").each(function () {
    var row = $(this);
    var label = row.find("td.TABLEHEADERCELL b").first().text().trim();
    var key = wanted[label];
    if (!key) return;
    var names = [];
    row.find("td.TABLEDETAILCELL img").each(function () {
      var alt = $(this).attr("alt");
      if (alt) names.push(alt.trim());
    });
    results[key] = names;
  });

  return { episodeNum: episodeNum, results: results };
}

// Parse picks.asp: returns {episodeNum, mysteryQuestion, picksDeadline (ISO)}
function parsePicksPage(html) {
  var $ = cheerio.load(html);
  var headerText = $(".PAGEHEADER").first().text();
  var epMatch = headerText.match(/Episode\s+(\d+)/i);
  if (!epMatch) throw new Error("Could not find episode number on picks.asp (header: \"" + headerText + "\")");
  var episodeNum = parseInt(epMatch[1], 10);

  var bodyText = $("body").text();
  var deadlineMatch = bodyText.match(/Picks Closed Date\/Time:\s*([\d/]+\s+[\d:]+\s*[AP]M)\s*ET/i);
  var picksDeadline = deadlineMatch ? etStringToUtcISO(deadlineMatch[1]) : null;

  var mysteryQuestion = null;
  $("span.SUBTITLE b").each(function () {
    if ($(this).text().trim() === "Mystery Question") {
      mysteryQuestion = $(this).closest("p").find("span.HIGHLIGHTTEXT b").first().text().trim() || null;
    }
  });

  return { episodeNum: episodeNum, mysteryQuestion: mysteryQuestion, picksDeadline: picksDeadline };
}

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    var auth = req.headers["authorization"] || "";
    if (auth !== "Bearer " + process.env.CRON_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  var log = [];
  try {
    var sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    var jar = new CookieJar();
    await siteLogin(jar, process.env.FANTASYSURVIVOR_EMAIL, process.env.FANTASYSURVIVOR_PASSWORD);
    log.push("Logged in to fantasysurvivor.net");

    // ---- Castaway name -> id lookup, from our own roster ----
    var castawaysRes = await sb.from("castaways").select("id,name,tribe,eliminated");
    if (castawaysRes.error) throw castawaysRes.error;
    var nameToId = {};
    castawaysRes.data.forEach(function (c) { nameToId[c.name.toLowerCase()] = c.id; });
    function slugify(displayName) {
      var id = nameToId[displayName.toLowerCase()];
      if (!id) throw new Error("Unknown castaway name from site: \"" + displayName + "\"");
      return id;
    }

    // ---- 1) Mirror the latest posted results (the episode that just aired) ----
    var resultsHtml = await siteGet(jar, "/game/results.asp");
    var parsedResults = parseResultsPage(resultsHtml);
    var resultsSlugged = {
      reward: parsedResults.results.reward.map(slugify),
      immunity: parsedResults.results.immunity.map(slugify),
      votedOff: parsedResults.results.votedOff.map(slugify),
      mystery: parsedResults.results.mystery.map(slugify),
      winner: null,
    };

    var upsertEp = await sb.from("episodes").upsert(
      { number: parsedResults.episodeNum, locked: true, results: resultsSlugged },
      { onConflict: "number" }
    );
    if (upsertEp.error) throw upsertEp.error;
    log.push("Locked/updated episode " + parsedResults.episodeNum + " with results: " + JSON.stringify(resultsSlugged));

    // Mark anyone voted off this episode as eliminated.
    for (var i = 0; i < resultsSlugged.votedOff.length; i++) {
      var outId = resultsSlugged.votedOff[i];
      var elimRes = await sb.from("castaways")
        .update({ eliminated: true, eliminated_episode: parsedResults.episodeNum })
        .eq("id", outId);
      if (elimRes.error) throw elimRes.error;
      log.push("Marked " + outId + " eliminated (episode " + parsedResults.episodeNum + ")");
    }

    // ---- 2) Mirror the currently-open episode's mystery question + deadline ----
    var picksHtml = await siteGet(jar, "/game/picks.asp");
    var parsedPicks = parsePicksPage(picksHtml);

    if (parsedPicks.episodeNum !== parsedResults.episodeNum) {
      var existingEp = await sb.from("episodes").select("number").eq("number", parsedPicks.episodeNum).maybeSingle();
      if (existingEp.error) throw existingEp.error;

      // Merge detection: if the active (non-eliminated) castaways are all on one tribe, it's merged.
      var afterElim = castawaysRes.data.map(function (c) {
        return resultsSlugged.votedOff.indexOf(c.id) >= 0 ? Object.assign({}, c, { eliminated: true }) : c;
      });
      var activeTribes = {};
      afterElim.forEach(function (c) { if (!c.eliminated) activeTribes[c.tribe] = true; });
      var merged = Object.keys(activeTribes).length <= 1;

      var upsertNext = await sb.from("episodes").upsert(
        {
          number: parsedPicks.episodeNum,
          picks_deadline: parsedPicks.picksDeadline,
          mystery_question: parsedPicks.mysteryQuestion,
          merged: merged,
          locked: existingEp.data ? undefined : false,
        },
        { onConflict: "number" }
      );
      if (upsertNext.error) throw upsertNext.error;
      log.push("Opened/updated episode " + parsedPicks.episodeNum +
        " (deadline " + parsedPicks.picksDeadline + ", merged=" + merged + ")");
    }

    return res.status(200).json({ ok: true, log: log });
  } catch (err) {
    log.push("ERROR: " + (err && err.message ? err.message : String(err)));
    return res.status(500).json({ ok: false, log: log });
  }
};
