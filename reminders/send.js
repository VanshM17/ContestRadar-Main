// ContestRadar reminder sender — runs on a cron (GitHub Actions, every 15 min).
// Reads users/{uid} docs (notifyList, emailOptIn, sentReminders), matches bell-on
// contests against live feeds, emails 24h + 1h windows via Resend, stamps sent
// markers so nothing ever double-fires. Usage: node send.js [--test you@mail].
import admin from 'firebase-admin';
import process from 'node:process';

const RESEND_KEY = (process.env.RESEND_API_KEY || '').trim();
const SENDER = process.env.SENDER || 'ContestRadar <onboarding@resend.dev>';
const WINDOWS = [
    { slot: '24h', before: 24 * 3600e3, tol: 30 * 60e3, subject: c => `Tomorrow: ${c.name}` },
    { slot: '1h', before: 3600e3, tol: 12 * 60e3, subject: c => `Starting in 1 hour: ${c.name}` },
];

if (!RESEND_KEY) throw new Error('Missing RESEND_API_KEY env');
if (!/^re_[A-Za-z0-9_-]{10,}$/.test(RESEND_KEY)) {
    throw new Error(`RESEND_API_KEY looks malformed (length ${RESEND_KEY.length}) — re-paste the re_... value with no quotes, spaces or newlines`);
}
let db = null;
function initDb() {
    if (db) return db;
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
    if (!svc.project_id) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT env');
    admin.initializeApp({ credential: admin.credential.cert(svc) });
    db = admin.firestore();
    return db;
}

const uid = c => (c.site + '|' + c.name + '|' + c.start_time).slice(0, 160);

async function getJSON(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
}

async function fetchAllContests() {
    const out = [];
    try {
        const cf = await getJSON('https://codeforces.com/api/contest.list');
        if (cf.status === 'OK') {
            for (const c of cf.result) {
                if (c.phase !== 'BEFORE') continue;
                const start = c.startTimeSeconds * 1000;
                out.push({
                    site: 'Codeforces', name: c.name, start_time: start,
                    end_time: start + (c.durationSeconds || 0) * 1000,
                    url: `https://codeforces.com/contest/${c.id}`
                });
            }
        }
    } catch (e) { console.warn('CF feed failed:', e.message); }
    try {
        const lccc = await getJSON('https://competeapi.vercel.app/contests/upcoming/');
        for (const c of lccc) {
            if (c.site !== 'leetcode' && c.site !== 'codechef') continue;
            out.push({
                site: c.site === 'leetcode' ? 'LeetCode' : 'CodeChef',
                name: c.title, start_time: c.startTime, end_time: c.endTime, url: c.url
            });
        }
    } catch (e) { console.warn('LCCC feed failed:', e.message); }
    try {
        const ac = await getJSON('https://contest-hive.vercel.app/api/atcoder');
        if (ac.ok) {
            for (const c of ac.data) {
                if (!/Beginner Contest|Regular Contest|Grand Contest/i.test(c.title)) continue;
                out.push({
                    site: 'AtCoder', name: c.title,
                    start_time: new Date(c.startTime).getTime(),
                    end_time: new Date(c.endTime).getTime(), url: c.url
                });
            }
        }
    } catch (e) { console.warn('AtCoder feed failed:', e.message); }
    return out.sort((a, b) => a.start_time - b.start_time);
}

function emailHtml(c, slot) {
    const when = new Date(c.start_time).toUTCString();
    const headline = slot === '24h' ? 'starts tomorrow' : 'starts in about an hour';
    const href = /^https?:\/\//i.test(c.url || '') ? c.url : 'https://codeforces.com/contests';
    return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#0b0e17;color:#f8fafc;border-radius:14px;padding:28px">
        <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#ff5353;font-weight:bold">ContestRadar reminder</div>
        <h2 style="margin:10px 0 4px">${escape(c.name)} ${headline}</h2>
        <p style="color:#8d97ab">${escape(c.site)} · ${escape(when)}</p>
        <a href="${escape(href)}" style="display:inline-block;margin:14px 0;background:#ff5353;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Open contest</a>
        <p style="color:#5b6478;font-size:12px;margin-top:18px">You're getting this because you rang the bell for this contest${slot === '24h' ? ' — one more email comes 1 hour before start' : ''}. Switch any bell off in ContestRadar Profile to stop these.</p>
    </div>`;
}
function escape(s) {
    return String(s || '').replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t] || t));
}

async function sendEmail(to, subject, html) {
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: SENDER, to, subject: String(subject).replace(/[\r\n]+/g, ' '), html })
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function main() {
    const testIdx = process.argv.indexOf('--test');
    if (testIdx >= 0 || process.env.TEST_EMAIL) {
        const to = process.argv[testIdx + 1] || process.env.TEST_EMAIL || '';
        if (!to || !to.includes('@')) throw new Error('Provide a test address: node send.js --test you@example.com');
        const contests = await fetchAllContests();
        const c = contests[0] || { site: 'Codeforces', name: 'Sample Contest', start_time: Date.now() + 36e5, url: 'https://codeforces.com' };
        await sendEmail(to, `Test: ${c.name} (ContestRadar reminders work)`, emailHtml(c, '1h'));
        console.log('test email sent to ' + to);
        return;
    }
    db = initDb();
    const contests = await fetchAllContests();
    const byUid = new Map(contests.map(c => [uid(c), c]));
    console.log(`loaded ${contests.length} contests`);
    const snap = await db.collection('users').get();
    const stats = { cf: 0, leetcode: 0, atcoder: 0, codechef: 0, bells: 0, optedOut: 0, emailsSent: 0 };
    snap.forEach(d => {
        const data = d.data() || {};
        const h = data.handles || {};
        if (h.cf) stats.cf++;
        if (h.leetcode) stats.leetcode++;
        if (h.atcoder) stats.atcoder++;
        if (h.codechef) stats.codechef++;
        stats.bells += (data.notifyList || []).length;
        if (data.emailOptIn === false) stats.optedOut++;
        stats.emailsSent += Object.keys(data.sentReminders || {}).length;
    });
    console.log(`users=${snap.size} handles(cf/lc/ac/cc)=${stats.cf}/${stats.leetcode}/${stats.atcoder}/${stats.codechef} bells=${stats.bells} optedOut=${stats.optedOut} emailsSent(all-time)=${stats.emailsSent}`);
    let sent = 0;
    for (const doc of snap.docs) {
        const u = doc.data();
        if (u.emailOptIn === false) continue;
        const wanted = new Set(u.notifyList || []);
        if (!wanted.size) continue;
        // Recipient comes from Firebase Auth, NEVER from the writable doc —
        // otherwise anyone could point our quota at someone else's inbox.
        let to = '';
        try {
            const rec = await admin.auth().getUser(doc.id);
            to = rec.email || '';
        } catch (e) { console.warn(`no auth user for ${doc.id}, skipping`); continue; }
        if (!to) continue;
        const markers = { ...(u.sentReminders || {}) };
        let changed = false;
        for (const id of wanted) {
            const c = byUid.get(id);
            if (!c) continue; // unknown or finished: skip quietly
            const diff = c.start_time - Date.now();
            if (diff < -3600e3) continue;
            for (const w of WINDOWS) {
                const key = id + '|' + w.slot;
                if (markers[key]) continue;
                if (Math.abs(diff - w.before) <= w.tol) {
                    await sendEmail(to, w.subject(c), emailHtml(c, w.slot));
                    markers[key] = Date.now();
                    changed = true;
                    sent++;
                    console.log(`sent ${w.slot} to ${to} :: ${c.name}`);
                }
            }
        }
        if (changed) await doc.ref.set({ sentReminders: markers }, { merge: true });
    }
    console.log(`done, ${sent} email(s) sent`);
}

main().catch(e => { console.error(e); process.exit(1); });
