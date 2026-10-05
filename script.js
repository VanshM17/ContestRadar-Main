// ---------- Original constants (kept) ----------
const CF_HANDLE = 'vanshmaheshwari'; // fallback default
const SITE_COLORS = {
    'Codeforces': 'var(--cf)',
    'LeetCode': 'var(--lc)',
    'AtCoder': 'var(--ac)',
    'CodeChef': 'var(--cc)'
};
const SITE_HEX = { 'Codeforces': '#4d8dfd', 'LeetCode': '#f59e0b', 'AtCoder': '#22c55e', 'CodeChef': '#a855f7' };
const LS_KEY = 'contestradar.v1';

// ---------- Tiny store ----------
const Store = {
    load() {
        try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
        catch { return {}; }
    },
    save(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); },
    get(k, fb) { const s = this.load(); return s[k] !== undefined ? s[k] : fb; },
    set(k, v) { const s = this.load(); s[k] = v; this.save(s); }
};

// ---------- State ----------
let ALL_CONTESTS = [];
let CF_HISTORY = [];      // [{contestId, contestName, rank, oldRating, newRating, time}]
let CF_USER = null;
let FILTER = 'all';
let QUERY = '';
let ELIGIBLE_ONLY = true;

// Analytics: one normalized store per platform.
// Normalized point: { t, rating, delta, rank (or null), name, extra }
let ACTIVE_PLATFORM = 'codeforces'; // codeforces | leetcode | codechef | atcoder
let LC_DATA = null;   // { points, current, meta }
let CC_DATA = null;
let AC_DATA = null;
let PLATFORM_RATINGS = { Codeforces: null, LeetCode: null, CodeChef: null, AtCoder: null };
const RATING_PENDING = {};
const ANALYTICS_SITES = { codeforces: 'Codeforces', leetcode: 'LeetCode', codechef: 'CodeChef', atcoder: 'AtCoder' };
const SITE_SHORT = { Codeforces: 'CF', LeetCode: 'LC', CodeChef: 'CC', AtCoder: 'AC' };
function handleForSite(site) {
    const u = user() || {};
    return ({ Codeforces: u.cf, LeetCode: u.leetcode, CodeChef: u.codechef, AtCoder: u.atcoder }[site] || '').trim();
}

const user = () => Store.get('user', null);

// ---------- Handle-change cooldown (one constant to tune) ----------
const HANDLE_COOLDOWN_DAYS = 30;
const HANDLE_COOLDOWN_MS = HANDLE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const HANDLE_GRACE_MS = 60 * 60 * 1000; // typo fixes within 1h of setting are always free
// Codeforces late-entry grace: past this point a running CF round is virtual-only.
const CF_LATE_ENTRY_GRACE_MS = 10 * 60 * 1000;
// Three-state contest status derived from each API's own start/end times —
// never guessed, never hardcoded per platform.
function liveState(c, now = Date.now()) {
    if (now < c.start_time) return 'upcoming';
    const hasWindow = Number.isFinite(c.end_time) && c.end_time > c.start_time;
    if (!hasWindow || now >= c.end_time) return 'ended'; // missing end: never shown as live
    if (c.site === 'Codeforces' && now - c.start_time > CF_LATE_ENTRY_GRACE_MS) return 'virtual';
    return 'live';
}
const getHandleLock = () => Store.get('handleLock', {});
// Locks may be plain millis (local/legacy) or Firestore Timestamps (cloud).
const tsNum = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (Number(v) || 0);
const lockTs = site => tsNum(getHandleLock()[site]);
const toTsMap = map => {
    const T = (window.FB && window.FB.ready) ? window.FB.Timestamp : null;
    const out = {};
    Object.entries(map || {}).forEach(([k, v]) => {
        const n = tsNum(v);
        out[k] = (T && n) ? T.fromMillis(n) : (n || 0);
    });
    return out;
};
function handleUnlockAt(site) {
    const ts = lockTs(site);
    return ts ? ts + HANDLE_COOLDOWN_MS : 0;
}
function canChangeHandle(site) {
    const ts = lockTs(site);
    if (!ts) return true;                       // never set → free
    if (Date.now() - ts < HANDLE_GRACE_MS) return true; // typo grace
    return Date.now() >= ts + HANDLE_COOLDOWN_MS;
}
function lockDate(ts) {
    return new Date(ts + HANDLE_COOLDOWN_MS).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---------- Cloud (Firebase) adapter — localStorage stays as offline cache ----------
// Everything cloud-related funnels through here; the rest of the app is untouched.
const Cloud = {
    user: null,      // firebase user (null = local-only mode)
    profile: null,    // last Firestore doc snapshot
    _listening: false,
    get on() { return !!(window.FB && window.FB.ready); },
    docRef() { return window.FB.doc(window.FB.db, 'users', this.user.uid); },
    async pull() {
        const snap = await window.FB.getDoc(this.docRef());
        if (snap.exists()) { this.profile = snap.data(); return this.profile; }
        return null;
    },
    async push() {
        if (!this.user) return;
        const u = user() || {};
        // Never upload a blank profile over a good cloud doc (logout races, empty states).
        if (!u.name && !u.cf && !u.leetcode && !u.atcoder && !u.codechef) return;
        const data = {
            email: this.user.email || '',
            name: u.name || this.user.displayName || '',
            handles: {
                cf: u.cf || '', leetcode: u.leetcode || '',
                atcoder: u.atcoder || '', codechef: u.codechef || ''
            },
            tracked: Store.get('tracked', []),
            participated: Store.get('participated', []),
            notifyList: Store.get('notifyList', []),
            emailOptIn: Store.get('emailOptIn', true),
            handleLock: toTsMap(Store.get('handleLock', {})),
            theme: Store.get('theme', 'system'),
            updatedAt: Date.now()
        };
        await window.FB.setDoc(this.docRef(), data, { merge: true });
        this.profile = data;
    },
    pushQuiet() { if (this.user) { this.push().catch(() => {}); } }
};
function applyCloudProfile(p) {
    if (!p) return;
    const h = p.handles || {};
    Store.set('user', {
        name: p.name || '', cf: h.cf || '', leetcode: h.leetcode || '',
        atcoder: h.atcoder || '', codechef: h.codechef || '', cloud: true
    });
    // Union-merge lists: guest stars/ticks made before login survive it.
    const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
    Store.set('tracked', union(Store.get('tracked', []), p.tracked));
    Store.set('participated', union(Store.get('participated', []), p.participated));
    if (Array.isArray(p.notifyList)) Store.set('notifyList', union(Store.get('notifyList', []), p.notifyList));
    if (typeof p.emailOptIn === 'boolean' && Store.get('emailOptIn', undefined) === undefined) Store.set('emailOptIn', p.emailOptIn);
    if (p.handleLock && typeof p.handleLock === 'object') Store.set('handleLock', p.handleLock);
    if (p.theme) applyTheme(p.theme);
}

// ---------- Cloud auth listener ----------
function initCloudAuth() {
    if (!Cloud.on || Cloud._listening) return;
    Cloud._listening = true;
    window.FB.onAuthStateChanged(window.FB.auth, async (fu) => {
        if (!fu) { Cloud.user = null; Cloud.profile = null; return; }
        Cloud.user = fu;
        try {
            const p = await Cloud.pull();
            const hasHandles = p && ((p.handles && (p.handles.cf || p.handles.leetcode || p.handles.atcoder || p.handles.codechef)) || p.name);
            if (hasHandles) {
                applyCloudProfile(p);
                toast(`Welcome back, ${(p.name || fu.displayName || 'coder')}!`, 'Profile synced from cloud.');
                // Fill any platform history missing from cache — ratings everywhere, every login.
                const missing = platformsNeedingSync();
                if (missing.length) {
                    Promise.all(missing.map(m => syncPlatform(m).then(() => true, () => false)))
                        .then(() => { renderAnalytics(); renderPast(); refreshAuthUI(); updateRatingLines(); });
                }
            } else {
                // First Google login: collect handles, then everything syncs.
                // Carry over any locally-saved handles so nothing is lost.
                const local = user() || {};
                $('auth-name').value = local.name || fu.displayName || '';
                if (local.cf) $('auth-cf').value = local.cf;
                if (local.leetcode) $('auth-lc').value = local.leetcode;
                if (local.atcoder) $('auth-ac').value = local.atcoder;
                if (local.codechef) $('auth-cc').value = local.codechef;
                openAuth();
            }
        } catch (e) {
            toast('Cloud sync failed', 'Working offline. ' + (e.message || ''));
        }
        refreshAuthUI(); fetchAllContests(); renderAnalytics();
    });
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
function toast(title, body = '') {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<b>${escapeHtml(title)}</b><span>${escapeHtml(body)}</span>`;
    $('toasts').appendChild(t);
    setTimeout(() => dismissToast(t), 5000);
}
function dismissToast(t) {
    if (!t || !t.isConnected || t.classList.contains('leaving')) return;
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 280);
}
function escapeHtml(str) {
    return String(str || '').replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}
function fmtDate(ms) {
    return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function countdown(ms) {
    const d = ms - Date.now();
    if (d <= 0) return 'started';
    const m = Math.floor(d / 60000);
    const days = Math.floor(m / 1440), hrs = Math.floor((m % 1440) / 60), mins = m % 60;
    if (days > 0) return `in ${days}d ${hrs}h`;
    if (hrs > 0) return `in ${hrs}h ${mins}m`;
    return `in ${mins}m`;
}
async function fetchJSON(url, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally { clearTimeout(t); }
}
function uid(c) { // stable id for tracking
    return (c.site + '|' + c.name + '|' + c.start_time).slice(0, 160);
}
// Contest URLs come from third-party mirrors — only ever open http(s).
function safeUrl(u) {
    try {
        const p = new URL(String(u || ''), location.origin);
        return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : '#';
    } catch { return '#'; }
}

// ============================================================================
// ORIGINAL: rating + eligibility (kept, only hardened)
// ============================================================================
async function getUserRating(handle) {
    try {
        const data = await fetchJSON(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`);
        if (data.status === 'OK' && data.result.length > 0) return data.result[0].rating || 0;
    } catch (e) { console.error('Failed to fetch rating:', e); }
    return 0;
}
function isEligibleContest(contestName, rating) {
    const nameLower = contestName.toLowerCase();
    if (nameLower.includes('div. 1 + div. 2') || nameLower.includes('global') || nameLower.includes('educational')) return true;
    if (nameLower.includes('div. 1') && !nameLower.includes('div. 2')) return rating >= 1900;
    return true;
}
async function fetchCodeforces(userRating) {
    try {
        const data = await fetchJSON('https://codeforces.com/api/contest.list');
        if (data.status !== 'OK') return [];
        return data.result
            .filter(c => (c.phase === 'BEFORE' || c.phase === 'CODING'))
            .filter(c => !ELIGIBLE_ONLY || isEligibleContest(c.name, userRating))
            .map(c => ({
                site: 'Codeforces', name: c.name,
                start_time: c.startTimeSeconds * 1000,
                end_time: c.startTimeSeconds * 1000 + (c.durationSeconds || 0) * 1000,
                is_live: c.phase === 'CODING',
                url: `https://codeforces.com/contest/${c.id}`
            }));
    } catch { return []; }
}
async function fetchLeetCodeAndCodeChef() {
    // Primary: CompeteAPI (original). Fallback: cached sample so UI never breaks.
    try {
        const data = await fetchJSON('https://competeapi.vercel.app/contests/upcoming/');
        const now = Date.now();
        const out = data
            .filter(c => c.site === 'leetcode' || c.site === 'codechef')
            .map(c => ({
                site: c.site === 'leetcode' ? 'LeetCode' : 'CodeChef',
                name: c.title, start_time: c.startTime,
                end_time: c.endTime,
                is_live: c.startTime <= now && now < c.endTime, url: c.url
            }));
        if (out.length) { Store.set('cache_lccc', { at: Date.now(), data: out }); return out; }
        throw new Error('empty');
    } catch (e) {
        console.warn('LCCC feed failed, using cache:', e);
        return Store.get('cache_lccc', { data: [] }).data || [];
    }
}
async function fetchAtCoder() {
    try {
        const data = await fetchJSON('https://contest-hive.vercel.app/api/atcoder');
        if (!data.ok) throw new Error('bad');
        const now = Date.now();
        const out = data.data
            .filter(c => /Beginner Contest|Regular Contest|Grand Contest/i.test(c.title))
            .map(c => {
                const start = new Date(c.startTime).getTime();
                const end = new Date(c.endTime).getTime();
                return { site: 'AtCoder', name: c.title, start_time: start, end_time: end, is_live: start <= now && now < end, url: c.url };
            })
            .slice(0, 5);
        if (out.length) Store.set('cache_at', { at: Date.now(), data: out });
        return out;
    } catch (e) {
        console.warn('AtCoder feed failed, using cache:', e);
        return Store.get('cache_at', { data: [] }).data || [];
    }
}

// ---------- Rating histories ----------
async function fetchCFProfile(handle) {
    const data = await fetchJSON(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`);
    if (data.status !== 'OK' || !data.result.length) throw new Error('CF user not found');
    return data.result[0];
}
async function fetchCFHistory(handle) {
    const data = await fetchJSON(`https://codeforces.com/api/user.rating?handle=${encodeURIComponent(handle)}`);
    if (data.status !== 'OK') throw new Error('No rating history');
    return data.result.map(r => ({
        contestId: r.contestId, contestName: r.contestName, rank: r.rank,
        oldRating: r.oldRating, newRating: r.newRating,
        delta: r.newRating - r.oldRating, time: r.ratingUpdateTimeSeconds * 1000
    }));
}
// ---------- Per-platform rating data (analytics + contest labels) ----------
async function fetchLeetCodeHistory(username) {
    const d = await fetchJSON(`https://alfa-leetcode-api.onrender.com/${encodeURIComponent(username)}/contest`);
    if (!d || !Array.isArray(d.contestParticipation)) throw new Error('No LeetCode contest data');
    const parts = d.contestParticipation
        .filter(p => p.attended && p.contest && p.contest.startTime)
        .sort((a, b) => a.contest.startTime - b.contest.startTime);
    if (!parts.length) throw new Error('No attended contests');
    const points = parts.map((p, i) => ({
        t: p.contest.startTime * 1000,
        rating: Math.round(p.rating),
        delta: i ? Math.round(p.rating - parts[i - 1].rating) : 0,
        rank: p.ranking || null,
        name: p.contest.title || 'LeetCode contest',
        extra: (p.problemsSolved != null) ? `${p.problemsSolved}/${p.totalProblems || '?'} solved` : ''
    }));
    return {
        points,
        current: Math.round(d.contestRating || points[points.length - 1].rating),
        meta: { attended: d.contestAttend, globalRank: d.contestGlobalRanking, topPct: d.contestTopPercentage, badge: (d.contestBadges && d.contestBadges.name) || '' }
    };
}
async function fetchText(url, timeoutMs = 25000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
    } finally { clearTimeout(t); }
}
async function fetchAtCoderHistoryData(handle) {
    const url = `https://atcoder.jp/users/${encodeURIComponent(handle)}/history/json`;
    // 1) Direct fetch (works if AtCoder ever opens CORS / in same-origin wrappers).
    try {
        const d = await fetchJSON(url);
        if (Array.isArray(d) && d.length) return normAtCoder(d);
    } catch { /* browsers block this (no CORS headers) - fall through to reader mirror */ }
    // 2) Reader mirror (CORS-open): raw JSON comes back embedded after a short header.
    let txt;
    try {
        txt = await fetchText(`https://r.jina.ai/${url}`);
    } catch (e) {
        throw new Error(/429|rate/i.test(e.message || '') ? 'AtCoder mirror is rate-limited - try again in a minute' : 'AtCoder history unreachable');
    }
    const a = txt.indexOf('['), b = txt.lastIndexOf(']');
    if (a < 0 || b <= a) throw new Error('No AtCoder history');
    let d;
    try { d = JSON.parse(txt.slice(a, b + 1)); }
    catch { throw new Error('No AtCoder history'); }
    if (!Array.isArray(d) || !d.length) throw new Error('No AtCoder history');
    return normAtCoder(d);
}
function normAtCoder(d) {
    const points = d.filter(x => x.IsRated !== false).map(x => ({
        t: new Date(x.EndTime).getTime(),
        rating: x.NewRating,
        delta: x.NewRating - x.OldRating,
        rank: x.Place || null,
        name: x.ContestName || 'AtCoder contest',
        extra: ''
    }));
    if (!points.length) throw new Error('No rated AtCoder contests');
    return { points, current: points[points.length - 1].rating, meta: {} };
}
// Your Cloudflare Worker: full CodeChef contest history (graph-capable).
const CC_PROXY_URL = 'https://contest-radar-codechef.vanshm17112005.workers.dev/?handle=';
async function fetchCodeChefData(handle) {
    // 1) Own Worker first — real per-contest history.
    try {
        const w = await fetchJSON(CC_PROXY_URL + encodeURIComponent(handle));
        if (w && Array.isArray(w.points) && w.points.length) {
            const points = w.points
                .map(p => ({
                    t: new Date(String(p.date).replace(' ', 'T')).getTime(),
                    rating: Math.round(Number(p.rating)),
                    delta: 0,
                    rank: p.rank != null && p.rank !== '' ? Number(p.rank) : null,
                    name: p.name || 'CodeChef contest',
                    extra: ''
                }))
                .filter(p => Number.isFinite(p.t) && Number.isFinite(p.rating))
                .sort((a, b) => a.t - b.t);
            for (let i = 1; i < points.length; i++) points[i].delta = points[i].rating - points[i - 1].rating;
            if (points.length) {
                const meta = { worker: true, maxRating: Math.max(...points.map(p => p.rating)) };
                // Best-effort enrichment: stars + global rank from the community mirror.
                try {
                    const d = await fetchJSON(`https://competeapi.vercel.app/user/codechef/${encodeURIComponent(handle)}`);
                    if (d) {
                        meta.stars = String(d.rating || '').replace(/[^0-9]/g, '');
                        meta.globalRank = String(d.global_rank || '').trim();
                    }
                } catch { /* enrichment only — graph works without it */ }
                return { points, current: points[points.length - 1].rating, meta };
            }
        }
        throw new Error('empty history');
    } catch (e) {
        // Real answers from the Worker (bad handle) must surface, not be masked.
        if (/HTTP 400|bad handle/i.test(e.message || '')) throw e;
        // Worker down / no history / blocked → fall through to the mirror.
    }
    // 2) Fallback: community mirror (current rating only, no graph).
    const d = await fetchJSON(`https://competeapi.vercel.app/user/codechef/${encodeURIComponent(handle)}`);
    if (!d || d.rating_number == null) throw new Error('CodeChef user not found or unrated');
    return {
        points: [],
        current: Number(d.rating_number),
        meta: { stars: String(d.rating || '').replace(/[^0-9]/g, ''), globalRank: String(d.global_rank || '').trim(), maxRating: d.max_rank }
    };
}
async function fetchCurrentRating(site, handle) {
    if (site === 'Codeforces') return getUserRating(handle);
    if (site === 'LeetCode') return (await fetchLeetCodeHistory(handle)).current;
    if (site === 'AtCoder') return (await fetchAtCoderHistoryData(handle)).current;
    if (site === 'CodeChef') return (await fetchCodeChefData(handle)).current;
    return null;
}
function cachedRating(site, handle) {
    const c = Store.get('platform_ratings', {});
    const e = c[site + '|' + handle.toLowerCase()];
    return (e && typeof e.rating === 'number') ? e.rating : null;
}
function storeCachedRating(site, handle, rating) {
    const c = Store.get('platform_ratings', {});
    c[site + '|' + handle.toLowerCase()] = { rating, at: Date.now() };
    Store.set('platform_ratings', c);
}
function ensurePlatformRating(site) {
    const h = handleForSite(site);
    if (!h) { PLATFORM_RATINGS[site] = null; updateRatingLines(); return Promise.resolve(null); }
    const c = cachedRating(site, h);
    if (c != null) { PLATFORM_RATINGS[site] = c; updateRatingLines(); return Promise.resolve(c); }
    if (RATING_PENDING[site] === h) return Promise.resolve(null);
    if (RATING_PENDING[site + '_fail'] && Date.now() - RATING_PENDING[site + '_fail'] < 5 * 60e3) return Promise.resolve(null);
    RATING_PENDING[site] = h;
    return fetchCurrentRating(site, h).then(r => {
        PLATFORM_RATINGS[site] = (typeof r === 'number' && Number.isFinite(r)) ? r : null;
        if (PLATFORM_RATINGS[site] != null) storeCachedRating(site, h, PLATFORM_RATINGS[site]);
    }).catch(() => { PLATFORM_RATINGS[site] = null; RATING_PENDING[site + '_fail'] = Date.now(); })
      .finally(() => { RATING_PENDING[site] = null; updateRatingLines(); });
}
// Rating labels under "Upcoming Contests" - always platform-aware, never hardcoded CF.
function updateRatingLines() {
    const u = user();
    const ul = $('user-line');
    if (!ul) return;
    if (!u) { ul.textContent = 'Link your handles in Profile for personalized filtering.'; return; }
    const base = `Signed in as ${u.name || u.cf || 'coder'}`;
    if (FILTER === 'all') {
        const bits = [];
        ['Codeforces', 'LeetCode', 'CodeChef', 'AtCoder'].forEach(s => {
            if (!handleForSite(s)) return;
            if (PLATFORM_RATINGS[s] == null) { ensurePlatformRating(s); bits.push(`${SITE_SHORT[s]} …`); }
            else bits.push(`${SITE_SHORT[s]} ${PLATFORM_RATINGS[s]}`);
        });
        ul.textContent = bits.length ? `${base} · ${bits.join(' · ')}` : `${base} · link handles in Profile for ratings`;
        return;
    }
    const h = handleForSite(FILTER);
    if (!h) { ul.textContent = `${base} · add your ${FILTER} handle in Profile`; return; }
    const r = PLATFORM_RATINGS[FILTER];
    if (r == null) { ensurePlatformRating(FILTER); ul.textContent = `${base} · fetching ${SITE_SHORT[FILTER]} rating…`; return; }
    ul.textContent = FILTER === 'Codeforces'
        ? `${base} · CF rating filter: ${r} (${cfTitle(r)})`
        : `${base} · ${SITE_SHORT[FILTER]} rating: ${r}`;
}

// ============================================================================
// Rendering: contest cards (original look + star/countdown)
// ============================================================================
function trackedSet() { return new Set(Store.get('tracked', [])); }
function participatedSet() { return new Set(Store.get('participated', [])); }

function visibleContests() {
    let list = [...ALL_CONTESTS].sort((a, b) => a.start_time - b.start_time);
    if (FILTER === '__live') list = list.filter(c => c.is_live);
    else if (FILTER !== 'all') list = list.filter(c => c.site === FILTER);
    if (QUERY) list = list.filter(c => (c.name + ' ' + c.site).toLowerCase().includes(QUERY));
    return list;
}

let ANIM_NEXT = false; // one-shot: stagger cards on the next render (filter switches)
function renderContests(anim = false) {
    if (ANIM_NEXT) { anim = true; ANIM_NEXT = false; }
    const el = $('contest-list');
    const list = visibleContests().slice(0, 12);
    $('contest-count').textContent = `${visibleContests().length} upcoming · showing ${list.length}`;
    if (!list.length) { el.innerHTML = '<p class="empty">No contests match. Try another filter.</p>'; return; }
    el.innerHTML = '';
    const tracked = trackedSet();
    list.forEach((contest, i) => {
        const id = uid(contest);
        const card = document.createElement('div');
        card.className = 'contest-card';
        if (anim) {
            card.classList.add('card-in');
            card.style.animationDelay = Math.min(i, 11) * 45 + 'ms';
        }
        card.style.setProperty('--site-color', SITE_COLORS[contest.site] || 'var(--cf)');
        const startTime = fmtDate(contest.start_time);
        const state = liveState(contest);
        card.innerHTML = `
            <div class="contest-card-header">
                <span class="site-tag"><span class="site-dot"></span>${contest.site}</span>
                <div class="card-actions">
                    <span class="status-badge ${state === 'live' ? 'live' : state === 'virtual' ? 'live-virtual' : ''}">${state === 'live' ? '<span class="pulse-dot"></span>LIVE · Join now' : state === 'virtual' ? '<span class="pulse-dot"></span>LIVE · Virtual only' : 'UPCOMING'}</span>
                    <button class="icon-btn ${tracked.has(id) ? 'starred' : ''}" data-star="${escapeHtml(id)}" title="Track this contest">${tracked.has(id) ? '★' : '☆'}</button>
                </div>
            </div>
            <div class="contest-title" title="${escapeHtml(contest.name)}">${escapeHtml(contest.name)}</div>
            <div class="contest-footer">
                <span class="contest-time">${startTime}<span class="countdown">${state === 'upcoming' ? escapeHtml(countdown(contest.start_time)) : state === 'live' ? '● running now' : state === 'virtual' ? '● virtual only' : 'ended'}</span></span>
                <span class="go-arrow">Open &#8599;</span>
            </div>`;
        card.addEventListener('click', (e) => {
            if (e.target.closest('[data-star]')) return;
            window.open(safeUrl(contest.url), '_blank', 'noopener');
        });
        el.appendChild(card);
    });
    el.querySelectorAll('[data-star]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // getAttribute() already resolves HTML entities, so this matches uid() exactly.
            // (No manual unescaping needed — a textarea-decode step here would double-decode
            // names containing sequences like "&lt;".)
            toggleTrack(btn.getAttribute('data-star'));
        });
    });
}

function toggleTrack(id) {
    const s = Store.get('tracked', []);
    const i = s.indexOf(id);
    if (i >= 0) { s.splice(i, 1); toast('Untracked', 'Removed from your watchlist.'); }
    else { s.push(id); toast('★ Tracked', 'Added to your watchlist.'); }
    Store.set('tracked', s);
    Cloud.pushQuiet();
    renderContests(); renderTracked();
}
function notifySet() { return new Set(Store.get('notifyList', [])); }
async function toggleNotify(contest) {
    const id = uid(contest);
    const list = Store.get('notifyList', []);
    const i = list.indexOf(id);
    if (i >= 0) {
        list.splice(i, 1);
        Store.set('notifyList', list);
        Cloud.pushQuiet();
        renderTracked();
        toast('Notifications off', 'No emails for this contest.');
        return;
    }
    if (!Cloud.user) {
        toast('Sign in required', 'Reminders need an email address — sign in with Google first.');
        switchView('profile');
        return;
    }
    const email = Cloud.user.email || 'your sign-in email';
    const yes = await confirmDialog('Email reminders?',
        `We'll email you 24 hours and 1 hour before "${contest.name}" starts. Emails go to ${email}. Switch any bell off anytime to stop.`,
        'Notify me');
    if (!yes) return;
    list.push(id);
    Store.set('notifyList', list);
    Cloud.pushQuiet();
    renderTracked();
    toast('Notifications on', 'You will get 2 emails for this contest.');
}

function findContestById(id) { return ALL_CONTESTS.find(c => uid(c) === id); }

function renderTracked() {
    const el = $('tracked-list');
    const ids = Store.get('tracked', []);
    if (!ids.length) { el.innerHTML = '<p class="muted small">Nothing tracked yet - hit ☆ on any contest card.</p>'; return; }
    el.innerHTML = '';
    ids.map(findContestById).filter(Boolean).sort((a, b) => a.start_time - b.start_time).forEach(c => {
        const row = document.createElement('div');
        row.className = 'track-row';
        const nid = uid(c);
        const bellOn = notifySet().has(nid);
        row.innerHTML = `<span class="dot-mini" style="background:${SITE_HEX[c.site]}"></span>
            <div class="grow"><div class="t-name">${escapeHtml(c.name)}</div><div class="t-time">${escapeHtml(c.site)} · ${fmtDate(c.start_time)} · ${escapeHtml(countdown(c.start_time))}</div></div>
            <button class="icon-btn" data-open title="Open">↗</button>
            <button class="icon-btn" data-ics title="Download .ics"><svg viewBox='0 0 16 16' width='14' height='14' fill='none' stroke='currentColor' stroke-width='1.5'><rect x='2' y='3' width='12' height='11' rx='2'/><path d='M2 6.5h12M5.5 1.5v3M10.5 1.5v3'/></svg></button>
            <button class="icon-btn ${bellOn ? 'bell-on' : ''}" data-bell title="Email me about this contest"><svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9'/><path d='M13.73 21a2 2 0 0 1-3.46 0'/></svg></button>
            <button class="icon-btn" data-del title="Remove">✕</button>`;
        row.querySelector('[data-open]').onclick = () => window.open(safeUrl(c.url), '_blank', 'noopener');
        row.querySelector('[data-ics]').onclick = () => downloadICS([c]);
        row.querySelector('[data-bell]').onclick = () => toggleNotify(c);
        row.querySelector('[data-del]').onclick = () => toggleTrack(uid(c));
        el.appendChild(row);
    });
}

async function renderPast() {
    const el = $('past-list');
    const manual = participatedSet();
    // Past = CF history (last 8) + any upcoming explicitly ticked
    const hist = [...CF_HISTORY].slice(-8).reverse();
    el.innerHTML = '';
    if (!hist.length && !manual.size) {
        el.innerHTML = '<p class="muted small">No history yet. Sync your CF handle in Analytics, or tick contests you played below.</p>';
    }
    hist.forEach(h => {
        const row = document.createElement('div');
        row.className = 'track-row';
        const d = h.delta >= 0 ? `+${h.delta}` : `${h.delta}`;
        row.innerHTML = `<span class="dot-mini" style="background:${SITE_HEX['Codeforces']}"></span>
            <div class="grow"><div class="t-name">${escapeHtml(h.contestName)}</div>
            <div class="t-time">Rank ${h.rank} · <b style="color:${h.delta >= 0 ? '#4ade80' : '#ff6b6b'}">${d}</b> → ${h.newRating}</div></div>
            <span class="tag">CF ✓ played</span>`;
        el.appendChild(row);
    });
    // Manual tick boxes for upcoming (participated vs skipped demo)
    const upcoming = [...ALL_CONTESTS].sort((a, b) => a.start_time - b.start_time).slice(0, 5);
    upcoming.forEach(c => {
        const id = uid(c);
        const row = document.createElement('div');
        row.className = 'track-row';
        row.innerHTML = `<label class="ckb"><input type="checkbox" ${manual.has(id) ? 'checked' : ''} data-man><span class="ckb-box"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3.2 3.2L12.5 5"/></svg></span></label>
            <div class="grow"><div class="t-name">${escapeHtml(c.name)}</div><div class="t-time">${escapeHtml(c.site)} · tick if you plan to play</div></div>`;
        row.querySelector('[data-man]').onchange = (e) => {
            const s = Store.get('participated', []);
            if (e.target.checked && !s.includes(id)) s.push(id);
            if (!e.target.checked) { const i = s.indexOf(id); if (i >= 0) s.splice(i, 1); }
            Store.set('participated', s);
            Cloud.pushQuiet();
        };
        el.appendChild(row);
    });
}

// ============================================================================
// Analytics
// ============================================================================
function cfTitle(r) {
    if (r == null) return 'Unrated';
    if (r < 1200) return 'Newbie';
    if (r < 1400) return 'Pupil';
    if (r < 1600) return 'Specialist';
    if (r < 1900) return 'Expert';
    if (r < 2100) return 'Candidate Master';
    if (r < 2300) return 'Master';
    if (r < 2400) return 'International Master';
    if (r < 2600) return 'Grandmaster';
    if (r < 3000) return 'Intl. Grandmaster';
    return 'Legendary Grandmaster';
}
// Rank colors for the CURRENT stat number (Codeforces palette).
function cfColor(r) {
    if (r == null) return '';
    if (r < 1200) return '#cccccc';   // Newbie
    if (r < 1400) return '#a1d679';   // Pupil
    if (r < 1600) return '#82d5b9';   // Specialist
    if (r < 1900) return '#aaaaff';   // Expert
    if (r < 2100) return '#fe88fe';   // Candidate Master
    if (r < 2300) return '#eccaa6';   // Master
    if (r < 2400) return '#e3b886';   // International Master
    if (r < 2600) return '#ff7778';   // Grandmaster
    if (r < 3000) return '#e64639';   // International Grandmaster
    return '#7c240b';                 // Legendary Grandmaster (body; first char rendered black at call site)
}
// AtCoder official rank colors.
function atColor(r) {
    if (r == null) return '';
    if (r < 400) return '#808080';    // Gray
    if (r < 800) return '#804000';    // Brown
    if (r < 1200) return '#008000';   // Green
    if (r < 1600) return '#00c0c0';   // Cyan
    if (r < 2000) return '#0000ff';   // Blue
    if (r < 2200) return '#c0c000';   // Yellow
    if (r < 2400) return '#ff8000';   // Orange
    return '#ff0000';                 // Red (2800+)
}
// LeetCode badge title from top %.
function lcTitle(topPct, badge) {
    const b = String(badge || '').toLowerCase();
    if (b.includes('king')) return 'King';
    if (b.includes('guardian')) return 'Guardian';
    if (b.includes('knight')) return 'Knight';
    if (topPct == null) return 'Unrated';
    if (topPct <= 1) return 'King';
    if (topPct <= 5) return 'Guardian';
    if (topPct <= 25) return 'Knight';
    return 'Unrated';
}
// AtCoder color name.
function atTitle(r) {
    if (r == null) return 'Unrated';
    if (r < 400) return 'Gray';
    if (r < 800) return 'Brown';
    if (r < 1200) return 'Green';
    if (r < 1600) return 'Cyan';
    if (r < 2000) return 'Blue';
    if (r < 2200) return 'Yellow';
    if (r < 2400) return 'Orange';
    return 'Red';
}
// Rank ink that auto-deepens on light backgrounds (keeps palettes readable).
function rankInk(c) {
    if (!c) return '';
    return document.documentElement.dataset.theme === 'light' ? shadeHex(c, 0.68) : c;
}
// CodeChef stars + official band colors (sourced from codechef.com/ratings).
function ccStars(r) {
    if (r == null) return 0;
    if (r >= 2500) return 7;
    if (r >= 2200) return 6;
    if (r >= 2000) return 5;
    if (r >= 1800) return 4;
    if (r >= 1600) return 3;
    if (r >= 1400) return 2;
    return 1;
}
function ccColor(r) {
    if (r == null) return '';
    if (r >= 2500) return '#D0011B';
    if (r >= 2200) return '#FF7F00';
    if (r >= 2000) return '#FFBF00';
    if (r >= 1800) return '#684273';
    if (r >= 1600) return '#3366CC';
    if (r >= 1400) return '#1E7D22';
    return '#666666';
}
function ccTitle(r) { const s = ccStars(r); return s ? `${s}★` : 'Unrated'; }
function lcColor(topPct, badge) {
    const b = String(badge || '').toLowerCase();
    if (b.includes('king') || (topPct != null && topPct <= 1)) return '#eab308';      // King · top 1%
    if (b.includes('guardian') || (topPct != null && topPct <= 5)) return '#599be5';  // Guardian · top 5%
    if (b.includes('knight') || (topPct != null && topPct <= 25)) return '#6bdc94';   // Knight · top 25%
    return '';
}
function tierPercentile(rating) {
    // Rough static distribution anchor (CF blog estimates): % of rated users BELOW typical marks
    const anchors = [[800, 8], [1200, 30], [1400, 48], [1600, 66], [1900, 82], [2100, 90], [2300, 95], [2600, 98.5]];
    if (rating == null) return null;
    for (const [mark, pct] of anchors) if (rating < mark) return pct;
    return 99.5;
}

function computeStats(hist) {
    if (!hist.length) return null;
    const deltas = hist.map(h => h.delta);
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const best = Math.max(...deltas), worst = Math.min(...deltas);
    // streak: consecutive contests with gap <= 30 days
    let streak = 1, bestStreak = 1;
    for (let i = 1; i < hist.length; i++) {
        const gap = (hist[i].t ?? hist[i].time) - (hist[i - 1].t ?? hist[i - 1].time);
        if (gap <= 30 * 864e5) { streak++; bestStreak = Math.max(bestStreak, streak); }
        else streak = 1;
    }
    const vol = Math.sqrt(deltas.reduce((a, d) => a + (d - avg) ** 2, 0) / deltas.length);
    const last = hist[hist.length - 1];
    return { avg, best, worst, streak: bestStreak, vol, n: hist.length, cur: last.rating ?? last.newRating };
}

// Animated numbers: tween from the last shown value to the new one (~0.9s).
function tweenNumber(el, to, opts = {}) {
    const { decimals = 0, format = null, duration = 900 } = opts;
    const from = (typeof el._v === 'number' && Number.isFinite(el._v)) ? el._v : 0;
    el._v = to;
    const render = v => { el.textContent = format ? format(v) : (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v))); };
    if (from === to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { render(to); return; }
    const t0 = performance.now();
    const step = (t) => {
        const p = Math.min(1, (t - t0) / duration);
        const e = 1 - Math.pow(1 - p, 3);
        render(from + (to - from) * e);
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
function tweenPair(el, a, b, duration = 900) {
    const f = Array.isArray(el._v) ? el._v : [0, 0];
    el._v = [a, b];
    const render = (x, y) => { el.textContent = `+${Math.round(x)} / ${Math.round(y)}`; };
    if ((f[0] === a && f[1] === b) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { render(a, b); return; }
    const t0 = performance.now();
    const step = (t) => {
        const p = Math.min(1, (t - t0) / duration);
        const e = 1 - Math.pow(1 - p, 3);
        render(f[0] + (a - f[0]) * e, f[1] + (b - f[1]) * e);
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
function clearStat(el) { el._v = undefined; el.textContent = '-'; }
function activeData() {
    if (ACTIVE_PLATFORM === 'leetcode') return LC_DATA;
    if (ACTIVE_PLATFORM === 'codechef') return CC_DATA;
    if (ACTIVE_PLATFORM === 'atcoder') return AC_DATA;
    if (!CF_HISTORY.length) return null;
    return {
        points: CF_HISTORY.map(h => ({ t: h.time, rating: h.newRating, delta: h.delta, rank: h.rank, name: h.contestName, extra: '' })),
        current: CF_HISTORY[CF_HISTORY.length - 1].newRating,
        meta: { cf: true }
    };
}
function renderAnalytics() {
    const site = ANALYTICS_SITES[ACTIVE_PLATFORM];
    const handle = handleForSite(site);
    const data = activeData();
    if (!data || !data.points.length) {
        $('analytics-sub').textContent = handle ? `No ${site} history for "${handle}" yet - hit Sync ratings.` : `Add your ${site} handle in Profile, then hit Sync.`;
        ['st-current', 'st-bestworst', 'st-avg', 'st-streak', 'st-tier'].forEach(id => { $(id)._v = undefined; $(id).textContent = '-'; });
        $('st-current').style.color = '';
        $('st-avg').className = 'stat-val';
        $('st-title').textContent = '-';
        $('st-contests').textContent = '0 contests';
        $('st-tier-sub').textContent = `among rated ${site} users`;
        $('history-body').innerHTML = '<tr><td colspan="5" class="muted">-</td></tr>';
        $('insights').innerHTML = `<li class="muted">${handle ? 'Nothing synced yet.' : `Add your ${site} handle in Profile.`}</li>`;
        drawChart([]);
        return;
    }
    const pts = data.points;
    const st = computeStats(pts);
    const cur = data.current;
    let titleBit = site;
    if (ACTIVE_PLATFORM === 'codeforces') titleBit = cfTitle(cur);
    else if (ACTIVE_PLATFORM === 'leetcode' && data.meta.topPct != null) titleBit = `top ${data.meta.topPct}% globally`;
    else if (ACTIVE_PLATFORM === 'codechef' && data.meta.stars) titleBit = `${ccTitle(cur)} coder`;
    $('analytics-sub').textContent = `${pts.length} rated ${site} contest${pts.length > 1 ? 's' : ''} · ${titleBit} · updated ${new Date().toLocaleTimeString()}`;
    $('st-current').className = 'stat-val';
    paintCurrentRating(cur, data);
    $('st-title').textContent = titleBit;
    if (pts.length > 1) {
        tweenPair($('st-bestworst'), st.best, st.worst);
        tweenNumber($('st-avg'), st.avg, { decimals: 1, format: v => (v >= 0 ? '+' : '') + v.toFixed(1) });
        $('st-avg').className = 'stat-val ' + (st.avg >= 0 ? 'up' : 'down');
        $('st-contests').textContent = `${st.n} contests`;
        tweenNumber($('st-streak'), st.streak);
    } else {
        clearStat($('st-bestworst'));
        clearStat($('st-avg'));
        $('st-avg').className = 'stat-val';
        $('st-contests').textContent = '1 contest';
        clearStat($('st-streak'));
    }
    if (ACTIVE_PLATFORM === 'codeforces') {
        const pct = tierPercentile(cur);
        if (pct != null) tweenNumber($('st-tier'), 100 - pct, { decimals: 1, format: v => `Top ${v.toFixed(1)}%` });
        else clearStat($('st-tier'));
        $('st-tier-sub').textContent = `${cfTitle(cur)} · ahead of ~${pct}% of rated CF users`;
    } else if (ACTIVE_PLATFORM === 'leetcode' && data.meta.topPct != null) {
        tweenNumber($('st-tier'), data.meta.topPct, { decimals: 2, format: v => `Top ${v.toFixed(2)}%` });
        $('st-tier-sub').textContent = `rank #${Number(data.meta.globalRank).toLocaleString()} · ${data.meta.attended || pts.length} contests`;
    } else if (ACTIVE_PLATFORM === 'codechef' && data.meta.globalRank && /[0-9]/.test(data.meta.globalRank)) {
        clearStat($('st-tier'));
        $('st-tier').textContent = `#${data.meta.globalRank.replace(/\s+/g, ' ')}`;
        $('st-tier-sub').textContent = 'global rank · CodeChef';
    } else {
        clearStat($('st-tier'));
        $('st-tier-sub').textContent = `among rated ${site} users`;
    }

    function shadeHex(hex, f) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const ch = v => Math.round(Math.min(255, Math.max(0, v * f)));
    return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
// Paints ONLY the CURRENT stat number in the user's rank color.
function paintCurrentRating(cur, data) {
    const el = $('st-current');
    el.className = 'stat-val';
    if (ACTIVE_PLATFORM === 'codeforces') {
        if (cur >= 3000) {
            // Legendary GM style: first character black, rest #7c240b.
            // (Black fill gets a faint halo so it stays visible on the dark card.)
            const s = String(cur);
            el.innerHTML = `<span style="color:#000;text-shadow:0 0 3px rgba(255,255,255,.65)">${escapeHtml(s[0])}</span>` +
                `<span style="color:#7c240b">${escapeHtml(s.slice(1))}</span>`;
        } else {
            el.style.color = rankInk(cfColor(cur));
            tweenNumber(el, cur);
        }
    } else if (ACTIVE_PLATFORM === 'leetcode') {
        el.style.color = rankInk(lcColor(data.meta.topPct, data.meta.badge));
        tweenNumber(el, cur);
    } else if (ACTIVE_PLATFORM === 'atcoder') {
        el.style.color = rankInk(atColor(cur));
        tweenNumber(el, cur);
    } else if (ACTIVE_PLATFORM === 'codechef') {
        el.style.color = rankInk(ccColor(cur));
        tweenNumber(el, cur);
    } else {
        el.style.color = '';
        tweenNumber(el, cur);
    }
}
// history table
    const tb = $('history-body');
    tb.innerHTML = '';
    [...pts].reverse().slice(0, 30).forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td title="${escapeHtml(p.name)}">${escapeHtml((p.name || '').slice(0, 34))}</td>
            <td>${p.rank != null ? p.rank : '-'}</td><td class="${p.delta >= 0 ? 'pos' : 'neg'}">${p.delta >= 0 ? '+' : ''}${p.delta}</td>
            <td>${p.rating}</td><td>${new Date(p.t).toLocaleDateString()}</td>`;
        tb.appendChild(tr);
    });

    // insights
    const ins = [];
    if (pts.length > 1) {
        const last5 = pts.slice(-5);
        const avg5 = last5.reduce((a, p) => a + p.delta, 0) / last5.length;
        const formMessage = avg5 > 30
            ? `<b>Superb:</b> +${avg5.toFixed(0)} average over last ${last5.length} ${site} contests.`
            : avg5 > 10
                ? `<b>Good Climb:</b> +${avg5.toFixed(0)} average over last ${last5.length} ${site} contests.`
                : avg5 >= 0
                    ? `<b>Consistent:</b> +${avg5.toFixed(0)} average over last ${last5.length} ${site} contests.`
                    : avg5 >= -10
                        ? `<b>Be careful:</b> ${avg5.toFixed(0)} average over last ${last5.length} ${site} contests.`
                        : avg5 >= -30
                            ? `<b>Be concerned for your rating:</b> ${avg5.toFixed(0)} average over last ${last5.length} ${site} contests.`
                            : `<b>Consider a break:</b> ${avg5.toFixed(0)} average over last ${last5.length} ${site} contests.`;
        ins.push(formMessage);
        const best = pts.reduce((a, b) => b.delta > a.delta ? b : a);
        const worst = pts.reduce((a, b) => b.delta < a.delta ? b : a);
        ins.push(`<b>Best:</b> ${escapeHtml((best.name || '').slice(0, 40))} (+${best.delta}${best.rank != null ? `, rank ${best.rank}` : ''}).`);
        ins.push(`<b>Worst:</b> ${escapeHtml((worst.name || '').slice(0, 40))} (${worst.delta}${worst.rank != null ? `, rank ${worst.rank}` : ''}).`);
        ins.push(`<b>Volatility σ = ${st.vol.toFixed(0)}</b> - ${st.vol > 120 ? 'high variance: be selective with rounds.' : 'steady climber: keep the volume up.'}`);
        if (ACTIVE_PLATFORM === 'codeforces') {
            const byType = {};
            CF_HISTORY.forEach(h => {
                const n = h.contestName.toLowerCase();
                const k = n.includes('educational') ? 'Educational' : n.includes('global') ? 'Global' : n.includes('div. 1') ? 'Div.1' : n.includes('div. 2') ? 'Div.2' : 'Other';
                (byType[k] = byType[k] || []).push(h.delta);
            });
            ins.push(`<b>By type:</b> ${escapeHtml(Object.entries(byType).map(([k, ds]) => `${k} ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(0)} average (${ds.length})`).join(' · '))}.`);
        }
    } else {
        ins.push(`Only 1 rated ${site} contest so far - play more rounds to unlock trends.`);
    }
    if (ACTIVE_PLATFORM === 'leetcode' && data.meta.globalRank) ins.push(`Global rank <b>#${Number(data.meta.globalRank).toLocaleString()}</b> among rated LeetCoders.`);
    if (ACTIVE_PLATFORM === 'codechef' && data.meta.maxRating) {
        const peak = Number(data.meta.maxRating);
        ins.push(Number.isFinite(peak) && peak > cur
            ? `Highest CodeChef rating <b>${peak}</b> — currently <b>${peak - cur}</b> below highest.`
            : `Highest CodeChef rating <b>${data.meta.maxRating}</b>.`);
    }
    $('insights').innerHTML = ins.map(i => `<li>${i}</li>`).join('');

    drawChart(pts.map(p => ({ t: p.t, v: p.rating, name: p.name, delta: p.delta, rank: p.rank, extra: p.extra })));
}

function hexToRgba(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(255,107,107,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// Minimal canvas line chart (no deps) - hover any point for its rating.
let CHART = { pts: [], hover: -1, geom: null, cx: null, cy: null, tx: 0, ty: 0, raf: null, morphing: false };
function drawChart(pts) {
    const next = pts || [];
    const prev = CHART.pts || [];
    CHART.hover = -1;
    CHART.cx = CHART.cy = null;
    stopHoverLoop();
    hideTip();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || (!prev.length && !next.length)) { CHART.pts = next; renderChart(); return; }
    if (!prev.length && next.length) { growChart(next); return; }
    if (prev.length && !next.length) { CHART.pts = next; renderChart(); return; }
    morphChart(prev, next);
}
// Resample a rating curve to N evenly spaced values (for morphing unequal lengths).
function sampleCurve(pts, n) {
    if (!pts.length) return [];
    if (pts.length === 1) return new Array(n).fill(pts[0].v);
    const out = [];
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1) * (pts.length - 1);
        const j = Math.floor(t), f = t - j;
        const a = pts[j].v, b = pts[Math.min(j + 1, pts.length - 1)].v;
        out.push(a + (b - a) * f);
    }
    return out;
}
// Morph the line from one dataset to another; axes recompute every frame.
function morphChart(prev, next) {
    const N = 60, DUR = 800;
    const a = sampleCurve(prev, N), b = sampleCurve(next, N);
    CHART.pts = next.map(p => ({ ...p }));
    CHART.morphing = true;
    const t0 = performance.now();
    const step = (t) => {
        const p = Math.min(1, (t - t0) / DUR);
        const e = 1 - Math.pow(1 - p, 3);
        const vals = a.map((v, i) => v + (b[i] - v) * e);
        const denom = Math.max(1, next.length - 1);
        CHART.pts = next.map((q, i) => ({ ...q, v: vals[Math.round(i / denom * (N - 1))] }));
        renderChart();
        if (p < 1) requestAnimationFrame(step);
        else { CHART.pts = next; CHART.morphing = false; renderChart(); }
    };
    requestAnimationFrame(step);
}
// Empty -> data: fade the canvas in on the fresh render.
function growChart(next) {
    const cv = $('rating-chart');
    CHART.pts = next;
    CHART.morphing = false;
    renderChart();
    if (!cv) return;
    cv.style.opacity = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => { cv.style.opacity = '1'; }));
}
// Year-aware date: "19 Nov" for the current year, "19 Nov 2019" for older ones.
function smartDate(t) {
    const d = new Date(t);
    const opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
}
function renderChart() {
    const cv = $('rating-chart'), empty = $('chart-empty');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.parentElement.clientWidth - 28, H = W < 480 ? 190 : 220;
    cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio;
    cv.style.height = H + 'px';
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pts = CHART.pts;
    if (!pts.length) { empty.style.display = 'flex'; CHART.geom = null; return; }
    empty.style.display = 'none';
    const vs = pts.map(p => p.v);
    let min = Math.min(...vs), max = Math.max(...vs);
    if (min === max) { min -= 50; max += 50; }
    const pad = 38;
    const X = i => pad + (W - pad - 12) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
    const Y = v => 12 + (H - 52) * (1 - (v - min) / (max - min));
    // theme-aware colors (chart follows the active theme)
    const css = getComputedStyle(document.documentElement);
    const CH = (css.getPropertyValue('--chart') || '').trim() || '#ff6b6b';
    const GRID = (css.getPropertyValue('--chart-grid') || '').trim() || 'rgba(255,255,255,.08)';
    const SUB = (css.getPropertyValue('--text-sub') || '').trim() || '#8d97ab';
    const FAINT = (css.getPropertyValue('--text-faint') || '').trim() || '#5b6478';
    // grid + y labels
    ctx.strokeStyle = GRID; ctx.fillStyle = SUB; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
        const v = Math.round(min + (max - min) * g / 4), y = Y(v);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - 8, y); ctx.stroke();
        ctx.fillText(String(v), 4, y + 4);
    }
    // area + line
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, hexToRgba(CH, 0.35)); grad.addColorStop(1, hexToRgba(CH, 0));
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(0), Y(p.v)));
    ctx.strokeStyle = CH; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.lineTo(X(pts.length - 1), H - 26); ctx.lineTo(X(0), H - 26); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    // hover crosshair (glides on the animated cx, not the snapped point)
    if (CHART.hover >= 0 && CHART.hover < pts.length && CHART.cx != null) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(CHART.cx, 8); ctx.lineTo(CHART.cx, H - 26); ctx.stroke();
        ctx.restore();
    }
    // dots on EVERY point
    pts.forEach((p, i) => {
        if (CHART.morphing) return; // dots pop back in on settle
        const isHov = i === CHART.hover;
        const px = (isHov && CHART.cx != null) ? CHART.cx : X(i);
        const py = (isHov && CHART.cy != null) ? CHART.cy : Y(p.v);
        ctx.beginPath(); ctx.arc(px, py, isHov ? 5.5 : 3, 0, 7);
        ctx.fillStyle = CH; ctx.fill();
        if (isHov) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    });
    // date ticks across the user's coding span (first contest → latest)
    ctx.fillStyle = FAINT; ctx.font = '11px sans-serif';
    const tickCount = pts.length === 1 ? 1 : Math.max(2, Math.min(6, Math.floor(W / 150)));
    let lastEdge = -Infinity;
    for (let k = 0; k < tickCount; k++) {
        const idx = pts.length === 1 ? 0 : Math.round(k * (pts.length - 1) / (tickCount - 1));
        const label = smartDate(pts[idx].t);
        const wTxt = ctx.measureText(label).width;
        let cx = X(idx) - wTxt / 2;
        if (k === 0) cx = Math.max(X(idx), pad);
        if (k === tickCount - 1) cx = Math.min(X(idx) - wTxt / 2, W - 8 - wTxt);
        if (cx < lastEdge) continue; // skip colliding labels on narrow screens
        ctx.fillText(label, cx, H - 8);
        lastEdge = cx + wTxt + 10;
    }
    CHART.geom = { xs: pts.map((_, i) => X(i)), ys: pts.map(p => Y(p.v)) };
}
function hideTip() {
    const tip = $('chart-tip');
    if (tip) tip.classList.add('hidden');
}
function chartHover(e) {
    const cv = $('rating-chart');
    if (!CHART.geom || !CHART.pts.length || CHART.morphing) return;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left);
    const xs = CHART.geom.xs;
    let best = 0, bestD = Infinity;
    xs.forEach((px, i) => { const d = Math.abs(px - x); if (d < bestD) { bestD = d; best = i; } });
    if (best !== CHART.hover) {
        CHART.hover = best;
        buildTip(best);
    }
    CHART.tx = xs[best];
    CHART.ty = CHART.geom.ys[best];
    if (CHART.cx == null) { CHART.cx = CHART.tx; CHART.cy = CHART.ty; renderChart(); positionTip(); }
    startHoverLoop();
    $('chart-tip').classList.remove('hidden');
}
function startHoverLoop() {
    if (CHART.raf) return;
    const step = () => {
        const dx = CHART.tx - CHART.cx, dy = CHART.ty - CHART.cy;
        if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
            CHART.cx = CHART.tx; CHART.cy = CHART.ty;
            CHART.raf = null;
            renderChart(); positionTip();
            return;
        }
        CHART.cx += dx * 0.12;
        CHART.cy += dy * 0.12;
        renderChart(); positionTip();
        CHART.raf = requestAnimationFrame(step);
    };
    CHART.raf = requestAnimationFrame(step);
}
function stopHoverLoop() {
    if (CHART.raf) cancelAnimationFrame(CHART.raf);
    CHART.raf = null;
}
function buildTip(best) {
    const p = CHART.pts[best];
    if (!p) return;
    const tip = $('chart-tip');
    const dCls = p.delta >= 0 ? 'pos' : 'neg';
    const dTxt = `${p.delta >= 0 ? '+' : ''}${p.delta}`;
    tip.innerHTML = `<div class="tip-name">${escapeHtml(p.name || 'Contest')}</div>
        <div class="tip-row">Rating <b>${p.v}</b> · <span class="${dCls}">${dTxt}</span>${p.rank != null ? ` · rank <b>${p.rank}</b>` : ''}</div>
        <div class="tip-row">${smartDate(p.t)}${p.extra ? ` · ${escapeHtml(p.extra)}` : ''}</div>`;
}
function positionTip() {
    const cv = $('rating-chart');
    if (!CHART.geom || CHART.cx == null) return;
    const tip = $('chart-tip');
    const wrapW = cv.parentElement.clientWidth;
    const tx = Math.min(Math.max(cv.offsetLeft + CHART.cx, 120), wrapW - 120);
    tip.style.left = tx + 'px';
    tip.style.top = (cv.offsetTop + CHART.cy) + 'px';
}

// Calendar export (.ics, no backend needed)
function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
function toICS(contests) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const evts = contests.map((c, i) => {
        const s = new Date(c.start_time).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        const e = new Date(c.start_time + 2 * 3600e3).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
        return ['BEGIN:VEVENT', `UID:cr-${Date.now()}-${i}@contestradar`,
            `DTSTAMP:${stamp}`, `DTSTART:${s}`, `DTEND:${e}`,
            `SUMMARY:${icsEscape('[' + c.site + '] ' + c.name)}`,
            `DESCRIPTION:${icsEscape(c.url || '')}`, `URL:${icsEscape(c.url || '')}`,
            'BEGIN:VALARM', 'TRIGGER:-PT24H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(c.name)}`, 'END:VALARM',
            'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(c.name)}`, 'END:VALARM',
            'END:VEVENT'].join('\r\n');
    }).join('\r\n');
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ContestRadar//EN', 'CALSCALE:GREGORIAN', evts, 'END:VCALENDAR'].join('\r\n');
}
function downloadICS(contests) {
    if (!contests.length) { toast('Nothing to export', 'Track a contest first.'); return; }
    const blob = new Blob([toICS(contests)], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'contestradar.ics'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Calendar file downloaded', 'Import into Google / Outlook and enable its email alerts.');
}
function contestsCSV() {
    const d = activeData();
    const site = ANALYTICS_SITES[ACTIVE_PLATFORM];
    const rows = [['contest', 'site', 'rank', 'delta', 'new_rating', 'date']];
    (d ? d.points : []).forEach(p => rows.push([`"${(p.name || '').replace(/"/g, '""')}"`, site, p.rank ?? '', p.delta, p.rating, new Date(p.t).toISOString()]));
    return rows.map(r => r.join(',')).join('\n');
}

// ============================================================================
// Accounts / profile
// ============================================================================
const isCloudUser = () => !!(Cloud.user && (user() || {}).cloud);
function updateProfileGate() {
    // Profile is account-only: guests see the sign-in gate (unless Firebase
    // itself is unreachable — then the local form stays as offline fallback).
    const gate = $('profile-gate'), cards = $('profile-cards');
    if (!gate || !cards) return;
    const locked = Cloud.on && !isCloudUser();
    gate.classList.toggle('hidden', !locked);
    cards.classList.toggle('hidden', locked);
}
function refreshAuthUI() {
    const u = user();
    $('auth-btn').textContent = u ? 'Switch user' : 'Sign in';
    $('user-chip').classList.toggle('hidden', !u);
    if (u) $('user-chip').textContent = `${u.name || u.cf || 'coder'}`;
    // profile fields + summary
    if (u) {
        $('pf-name').value = u.name || ''; $('pf-cf').value = u.cf || '';
        $('pf-lc').value = u.leetcode || ''; $('pf-ac').value = u.atcoder || ''; $('pf-cc').value = u.codechef || '';
        // Cooldown countdowns per handle.
        const locks = getHandleLock();
        [['cf', 'pf-cf', 'lock-cf'], ['leetcode', 'pf-lc', 'lock-lc'],
         ['atcoder', 'pf-ac', 'lock-ac'], ['codechef', 'pf-cc', 'lock-cc']].forEach(([k, inputId, lockId]) => {
            const lockEl = $(lockId), inputEl = $(inputId);
            if (!lockEl || !inputEl) return;
            const ts = lockTs(k);
            const hasValue = !!($(inputId).value || '').trim();
            if (!hasValue || !ts || Date.now() - ts < HANDLE_GRACE_MS) {
                lockEl.textContent = '';
                inputEl.disabled = false;
            } else if (Date.now() < ts + HANDLE_COOLDOWN_MS) {
                lockEl.textContent = `Handle locked — changes unlock ${lockDate(ts)}`;
                inputEl.disabled = true;
            } else {
                lockEl.textContent = '';
                inputEl.disabled = false;
            }
        });
        $('profile-summary').innerHTML =
            (u.cf ? `<span class="tag">CF: ${escapeHtml(u.cf)}</span>` : '') +
            (u.leetcode ? `<span class="tag">LC: ${escapeHtml(u.leetcode)}</span>` : '') +
            (u.atcoder ? `<span class="tag">AC: ${escapeHtml(u.atcoder)}</span>` : '') +
            (u.codechef ? `<span class="tag">CC: ${escapeHtml(u.codechef)}</span>` : '');
        updateRatingLines();
    } else {
        $('user-line').textContent = 'Sign in to link your handles and unlock personalized analytics.';
    }
    updateProfileGate();
    const eo = $('email-optin');
    if (eo) {
        eo.checked = Store.get('emailOptIn', true);
        if (!eo.dataset.bound) {
            eo.dataset.bound = '1';
            eo.onchange = () => {
                Store.set('emailOptIn', eo.checked);
                Cloud.pushQuiet();
                toast(eo.checked ? 'Reminders on' : 'Reminders off',
                    eo.checked ? 'Bell-on contests will email you.' : 'No reminder emails until re-enabled.');
            };
        }
    }
    renderConnected();
}
function renderConnected() {
    const u = user() || {};
    const rows = [];
    const dot = s => `<span class="dot-mini" style="background:${SITE_HEX[s]}"></span>`;
    const row = (site, inner) => `<div class="conn-row">${dot(site)}<div class="grow">${inner}</div></div>`;
    const pending = site => `<span class="muted small"> — sync pending</span>`;
    // Codeforces: handle · rating title · highest
    if (CF_USER) {
        const cc = rankInk(cfColor(CF_USER.rating));
        rows.push(row('Codeforces',
            `<b>Codeforces:</b> <b>${escapeHtml(CF_USER.handle)}</b> · ` +
            `<b style="color:${cc}">${CF_USER.rating || 'unrated'}</b> ` +
            `<span style="color:${cc}">${escapeHtml(cfTitle(CF_USER.rating))}</span> · Highest ${CF_USER.maxRating || '—'}`));
    } else if (u.cf) {
        rows.push(row('Codeforces', `Codeforces <b>${escapeHtml(u.cf)}</b>${pending()}`));
    }
    // LeetCode: handle · rating badge · top % (badge word only when earned)
    if (LC_DATA) {
        const m = LC_DATA.meta;
        const badge = lcTitle(m.topPct, m.badge);
        const bc = rankInk(lcColor(m.topPct, m.badge));
        rows.push(row('LeetCode',
            `LeetCode: <b>${escapeHtml(u.leetcode || '')}</b> · ` +
            `<b style="color:${bc}">${LC_DATA.current}</b>` +
            (badge !== 'Unrated' ? ` <span style="color:${bc}">${escapeHtml(badge)}</span>` : '') +
            (m.topPct != null ? ` · Top ${m.topPct}%` : '')));
    } else if (u.leetcode) {
        const r = PLATFORM_RATINGS.LeetCode;
        rows.push(row('LeetCode', `LeetCode: <b>${escapeHtml(u.leetcode)}</b>` +
            (r != null ? ` · <b>${r}</b>` : pending())));
    }
    // AtCoder: handle · rating color name
    if (AC_DATA) {
        const ac = rankInk(atColor(AC_DATA.current));
        rows.push(row('AtCoder',
            `AtCoder: <b>${escapeHtml(u.atcoder || '')}</b> · ` +
            `<b style="color:${ac}">${AC_DATA.current}</b> ` +
            `<span style="color:${ac}">${atTitle(AC_DATA.current)}</span>`));
    } else if (u.atcoder) {
        const r = PLATFORM_RATINGS.AtCoder;
        const ac = rankInk(atColor(r));
        rows.push(row('AtCoder', `AtCoder: <b>${escapeHtml(u.atcoder)}</b>` +
            (r != null ? ` · <b style="color:${ac}">${r}</b> <span style="color:${ac}">${atTitle(r)}</span>` : pending())));
    }
    // CodeChef: handle · rating stars · highest
    if (CC_DATA) {
        const m = CC_DATA.meta || {};
        const kc = rankInk(ccColor(CC_DATA.current));
        rows.push(row('CodeChef',
            `CodeChef: <b>${escapeHtml(u.codechef || '')}</b> · ` +
            `<b style="color:${kc}">${CC_DATA.current}</b> ` +
            `<span style="color:${kc}">${ccTitle(CC_DATA.current)}</span>` +
            (m.maxRating ? ` · Highest ${m.maxRating}` : '')));
    } else if (u.codechef) {
        const r = PLATFORM_RATINGS.CodeChef;
        const kc = rankInk(ccColor(r));
        rows.push(row('CodeChef', `CodeChef: <b>${escapeHtml(u.codechef)}</b>` +
            (r != null ? ` · <b style="color:${kc}">${r}</b> <span style="color:${kc}">${ccTitle(r)}</span>` : pending())));
    }
    $('connected-list').innerHTML = rows.length ? rows.join('') : '<p class="muted small">No handles linked yet.</p>';
}
function saveUser(patch) {
    const u = user() || {};
    Store.set('user', { ...u, ...patch });
    refreshAuthUI();
}

// ============================================================================
// Boot: fetch all contests (original flow, extended)
// ============================================================================
async function fetchAllContests() {
    const listElement = $('contest-list');
    const u = user();
    const handle = (u && u.cf) || CF_HANDLE;
    const userRating = await getUserRating(handle).catch(() => 0);
    try { CF_USER = await fetchCFProfile(handle).catch(() => null); } catch { CF_USER = null; }

    const [cfContests, lcCcContests, atContests] = await Promise.all([
        fetchCodeforces(userRating), fetchLeetCodeAndCodeChef(), fetchAtCoder()
    ]);
    ALL_CONTESTS = [...cfContests, ...lcCcContests, ...atContests]
        .sort((a, b) => a.start_time - b.start_time);
    Store.set('cache_all', { at: Date.now(), data: ALL_CONTESTS });
    $('sync-label').textContent = `Live · synced ${new Date().toLocaleTimeString()}`;
    renderContests(); renderTracked(); refreshAuthUI();
    if (CF_USER && CF_USER.rating != null) PLATFORM_RATINGS.Codeforces = CF_USER.rating;
    else if (userRating) PLATFORM_RATINGS.Codeforces = userRating;
    ['LeetCode', 'CodeChef', 'AtCoder'].forEach(s => { if (handleForSite(s) && PLATFORM_RATINGS[s] == null) ensurePlatformRating(s); });
    updateRatingLines();
}
async function syncPlatform(platform) {
    // Syncs ONE platform's history + rating cache. Throws on failure.
    // Returns a short status string for summary toasts.
    const site = ANALYTICS_SITES[platform];
    const handle = handleForSite(site);
    if (!handle) throw new Error(`no ${site} handle`);
    if (platform === 'codeforces') {
        CF_USER = await fetchCFProfile(handle);
        CF_HISTORY = await fetchCFHistory(handle);
        Store.set('cf_history', { at: Date.now(), handle, data: CF_HISTORY });
        Store.set('cf_user', { at: Date.now(), data: CF_USER });
        if (CF_USER && CF_USER.rating != null) { PLATFORM_RATINGS.Codeforces = CF_USER.rating; storeCachedRating('Codeforces', handle, CF_USER.rating); }
        return `${site} (${CF_HISTORY.length} contests)`;
    }
    if (platform === 'leetcode') {
        LC_DATA = await fetchLeetCodeHistory(handle);
        Store.set('lc_history', { at: Date.now(), handle, data: LC_DATA });
        PLATFORM_RATINGS.LeetCode = LC_DATA.current; storeCachedRating('LeetCode', handle, LC_DATA.current);
        return `${site} (${LC_DATA.points.length} contests)`;
    }
    if (platform === 'atcoder') {
        AC_DATA = await fetchAtCoderHistoryData(handle);
        Store.set('ac_history', { at: Date.now(), handle, data: AC_DATA });
        PLATFORM_RATINGS.AtCoder = AC_DATA.current; storeCachedRating('AtCoder', handle, AC_DATA.current);
        return `${site} (${AC_DATA.points.length} contests)`;
    }
    if (platform === 'codechef') {
        CC_DATA = await fetchCodeChefData(handle);
        Store.set('cc_history', { at: Date.now(), handle, data: CC_DATA });
        PLATFORM_RATINGS.CodeChef = CC_DATA.current; storeCachedRating('CodeChef', handle, CC_DATA.current);
        return `${site} (rating ${CC_DATA.current})`;
    }
    throw new Error('unknown platform');
}
function platformsNeedingSync() {
    // Linked handles with no loaded history — filled quietly on returning login.
    const out = [];
    if (handleForSite('Codeforces') && !CF_HISTORY.length) out.push('codeforces');
    if (handleForSite('LeetCode') && !LC_DATA) out.push('leetcode');
    if (handleForSite('AtCoder') && !AC_DATA) out.push('atcoder');
    if (handleForSite('CodeChef') && !CC_DATA) out.push('codechef');
    return out;
}
async function syncAllPlatforms() {
    // Syncs every linked handle (login + profile save). Never throws.
    const platforms = ['codeforces', 'leetcode', 'atcoder', 'codechef']
        .filter(p => handleForSite(ANALYTICS_SITES[p]));
    const settled = await Promise.all(platforms.map(p =>
        syncPlatform(p).then(
            msg => ({ ok: true, msg }),
            e => ({ ok: false, msg: `${ANALYTICS_SITES[p]}: ${e.message || 'failed'}` })
        )
    ));
    renderAnalytics(); renderPast(); refreshAuthUI(); updateRatingLines();
    return settled;
}
async function syncAnalytics() {
    const site = ANALYTICS_SITES[ACTIVE_PLATFORM];
    const handle = handleForSite(site);
    if (!handle) { toast('No handle', `Add your ${site} handle in Profile first.`); renderAnalytics(); return; }
    $('analytics-sub').textContent = `Syncing ${site} @${handle}…`;
    try {
        const msg = await syncPlatform(ACTIVE_PLATFORM);
        toast('Ratings synced', `${msg} for @${handle}.`);
    } catch (e) {
        toast('Sync failed', 'Check the handle / API. ' + (e.message || ''));
    }
    renderAnalytics(); renderPast(); refreshAuthUI(); updateRatingLines();
}
function restorePlatformCaches() {
    const u = user() || {};
    const take = (key, handle, apply) => {
        const c = Store.get(key, null);
        if (c && c.handle && c.handle.toLowerCase() === (handle || '').toLowerCase() && c.data) apply(c.data);
    };
    take('lc_history', u.leetcode, d => { LC_DATA = d; PLATFORM_RATINGS.LeetCode = d.current; });
    take('ac_history', u.atcoder, d => { AC_DATA = d; PLATFORM_RATINGS.AtCoder = d.current; });
    take('cc_history', u.codechef, d => { CC_DATA = d; PLATFORM_RATINGS.CodeChef = d.current; });
}

// ============================================================================
// Wiring
// ============================================================================
const THEMES = { dark: 'Dark mode', light: 'Light mode', system: 'System' };
const OS_LIGHT = window.matchMedia('(prefers-color-scheme: light)');
function resolveTheme(name) {
    if (name === 'system') return OS_LIGHT.matches ? 'light' : 'dark';
    return THEMES[name] ? name : 'dark';
}
function applyTheme(name, save = true) {
    if (!THEMES[name]) name = 'system';
    if (save) { Store.set('theme', name); Cloud.pushQuiet(); }
    const real = resolveTheme(name);
    document.documentElement.dataset.theme = real;
    const tt = $('theme-toggle');
    if (tt) { tt.dataset.mode = name; tt.title = 'Theme: ' + (THEMES[name] || name); }
    const meta = $('meta-theme');
    if (meta) meta.setAttribute('content', real === 'light' ? '#e9edf3' : '#05070d');
    const av = $('view-analytics');
    if (av && av.classList.contains('active')) renderChart();
}
OS_LIGHT.onchange = () => { if (Store.get('theme', 'system') === 'system') applyTheme('system', false); };
// Custom dropdowns: replace native select popups with themed glass menus.
// The original <select> stays hidden as the value store; all logic keeps working.
const DD_REG = new Map();
function syncDropdown(sel) {
    const sync = DD_REG.get(sel);
    if (sync) sync();
}
function makeDropdown(select) {
    if (!select || DD_REG.has(select)) return;
    const wrap = document.createElement('div');
    wrap.className = 'dd';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.innerHTML = `<span class="dd-label"></span><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>`;
    const menu = document.createElement('div');
    menu.className = 'dd-menu hidden';
    menu.setAttribute('role', 'listbox');
    const hi = document.createElement('span');
    hi.className = 'dd-hi';
    menu.appendChild(hi);
    // animate-ui style: one highlight backdrop that glides between hovered items.
    const placeHi = (el) => {
        if (!el) { hi.style.opacity = '0'; return; }
        hi.style.opacity = '1';
        hi.style.left = el.offsetLeft + 'px';
        hi.style.top = el.offsetTop + 'px';
        hi.style.width = el.offsetWidth + 'px';
        hi.style.height = el.offsetHeight + 'px';
        requestAnimationFrame(() => hi.classList.add('ready'));
    };
    menu.onmouseleave = () => placeHi(menu.querySelector('.dd-opt.selected'));
    const sync = () => {
        const idx = select.selectedIndex;
        const opt = select.options[idx];
        btn.querySelector('.dd-label').textContent = opt ? opt.textContent : '';
        menu.querySelectorAll('.dd-opt').forEach((el, i) => {
            const on = i === idx;
            el.classList.toggle('selected', on);
            el.querySelector('.dd-check').style.visibility = on ? 'visible' : 'hidden';
        });
        placeHi(menu.querySelector('.dd-opt.selected'));
    };
    [...select.options].forEach((o, i) => {
        const el = document.createElement('div');
        el.className = 'dd-opt';
        el.setAttribute('role', 'option');
        el.innerHTML = `<span class="dd-check">✓</span><span></span>`;
        el.querySelector('span:last-child').textContent = o.textContent;
        el.onclick = (e) => {
            e.stopPropagation();
            select.selectedIndex = i;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            sync(); close();
        };
        el.onmouseenter = () => placeHi(el);
        menu.appendChild(el);
    });
    const close = () => {
        menu.classList.add('hidden');
        btn.classList.remove('open');
        document.removeEventListener('click', outside);
    };
    const outside = (e) => { if (!wrap.contains(e.target)) close(); };
    btn.onclick = (e) => {
        e.stopPropagation();
        const willOpen = menu.classList.contains('hidden');
        document.querySelectorAll('.dd-menu').forEach(m => m.classList.add('hidden'));
        document.querySelectorAll('.dd-btn.open').forEach(b => b.classList.remove('open'));
        if (willOpen) {
            menu.classList.remove('hidden');
            placeHi(menu.querySelector('.dd-opt.selected'));
            btn.classList.add('open');
            document.addEventListener('click', outside);
        } else close();
    };
    btn.onkeydown = (e) => { if (e.key === 'Escape') close(); };
    select.after(wrap);
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    select.classList.add('hidden');
    DD_REG.set(select, sync);
    sync();
}
const CHIP_GLOW = { 'Codeforces': '#4d8dfd', 'LeetCode': '#f59e0b', 'CodeChef': '#a855f7', 'AtCoder': '#22c55e' };
function moveChipPill() {
    const bar = $('platform-filters');
    if (!bar) return;
    let pill = bar.querySelector(':scope > .chip-pill');
    if (!pill) { pill = document.createElement('span'); pill.className = 'chip-pill'; bar.prepend(pill); }
    const active = bar.querySelector(':scope > .chip.active');
    if (!active || active.offsetWidth === 0) { pill.style.opacity = '0'; return; }
    pill.style.opacity = '1';
    pill.style.left = active.offsetLeft + 'px';
    pill.style.top = active.offsetTop + 'px';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    const glow = CHIP_GLOW[FILTER];
    pill.style.borderColor = glow || '';
    pill.style.boxShadow = glow ? `0 0 0 1px ${glow}, 0 0 14px ${glow}66` : '';
    requestAnimationFrame(() => pill.classList.add('ready'));
}
function placeNavPill(bar, el) {
    if (!bar) return;
    let pill = bar.querySelector(':scope > .nav-pill');
    if (!pill) { pill = document.createElement('span'); pill.className = 'nav-pill'; bar.prepend(pill); }
    if (!el || el.offsetWidth === 0) { pill.style.opacity = '0'; return; }
    pill.style.opacity = '1';
    pill.style.left = el.offsetLeft + 'px';
    pill.style.top = el.offsetTop + 'px';
    pill.style.width = el.offsetWidth + 'px';
    pill.style.height = el.offsetHeight + 'px';
    requestAnimationFrame(() => pill.classList.add('ready'));
}
function moveNavPill(bar) {
    if (!bar) return;
    placeNavPill(bar, bar.querySelector(':scope > .nav-tab.active'));
}
function wireNavHover(bar) {
    if (!bar || bar.dataset.hoverWired) return;
    bar.dataset.hoverWired = '1';
    bar.querySelectorAll(':scope > .nav-tab').forEach(t => {
        t.onmouseenter = () => placeNavPill(bar, t);
    });
    bar.onmouseleave = () => moveNavPill(bar);
}
function moveNavPills() {
    moveNavPill(document.querySelector('.topnav .nav-tabs'));
    const mm = $('mobile-menu');
    if (mm && !mm.classList.contains('hidden')) moveNavPill(mm);
}
// Smooth caret: hide the native block caret, glide a themed twin instead.
// Skipped on touch devices + reduced-motion (native caret stays there).
const caretMirror = (() => {
    const m = document.createElement('div');
    m.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:-9999px;left:0;pointer-events:none;';
    document.documentElement.appendChild(m);
    return m;
})();
const caretActive = new Set();
let caretRaf = null;
function caretLoop() {
    caretActive.forEach(state => {
        const d = state.tx - state.cx;
        if (Math.abs(d) < 0.3) {
            if (state.cx !== state.tx) {
                state.cx = state.tx;
                state.el.style.left = state.cx + 'px';
            }
            state.caret.classList.remove('moving');
            return;
        }
        state.cx += d * 0.35;
        state.el.style.left = state.cx + 'px';
        state.caret.classList.add('moving');
    });
    caretRaf = caretActive.size ? requestAnimationFrame(caretLoop) : null;
}
function caretWake(state) {
    measureCaret(state);
    if (!caretActive.has(state)) caretActive.add(state);
    if (!caretRaf) caretRaf = requestAnimationFrame(caretLoop);
}
function measureCaret(state) {
    const input = state.input;
    const cs = getComputedStyle(input);
    caretMirror.style.fontFamily = cs.fontFamily;
    caretMirror.style.fontSize = cs.fontSize;
    caretMirror.style.fontWeight = cs.fontWeight;
    caretMirror.style.letterSpacing = cs.letterSpacing;
    const pos = input.selectionStart ?? input.value.length;
    caretMirror.textContent = input.value.slice(0, Math.max(0, pos));
    const padL = parseFloat(cs.paddingLeft) || 0, bdrL = parseFloat(cs.borderLeftWidth) || 0;
    const padT = parseFloat(cs.paddingTop) || 0, bdrT = parseFloat(cs.borderTopWidth) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0, bdrB = parseFloat(cs.borderBottomWidth) || 0;
    state.tx = input.offsetLeft + bdrL + padL + caretMirror.scrollWidth - input.scrollLeft;
    if (state.cx == null) state.cx = state.tx;
    // Caret height follows the TEXT size (native-like proportions), not the box.
    let top, h;
    if (input.tagName === 'TEXTAREA') {
        top = input.offsetTop + bdrT + padT;
        h = Math.max(10, input.clientHeight - padT - padB - bdrT - bdrB);
    } else {
        const fs = parseFloat(cs.fontSize) || 14;
        h = Math.round(fs * 1.15);
        const innerTop = input.offsetTop + bdrT;
        const innerH = input.clientHeight - bdrT - bdrB;
        top = innerTop + Math.max(0, (innerH - h) / 2);
    }
    if (state.el.style.top !== top + 'px') {
        state.el.style.top = top + 'px';
        state.el.style.height = h + 'px';
    }
    const collapsed = input.selectionStart === input.selectionEnd;
    state.caret.classList.toggle('sel-hidden', !collapsed);
}
function attachSmoothCaret(input) {
    if (input.dataset.caretAttached) return;
    input.dataset.caretAttached = '1';
    let host = input.parentElement;
    if (!host || getComputedStyle(host).position === 'static') {
        const wrap = document.createElement('span');
        wrap.className = 'caret-wrap';
        input.before(wrap);
        wrap.appendChild(input);
        host = wrap;
    }
    const caret = document.createElement('span');
    caret.className = 'smooth-caret';
    caret.setAttribute('aria-hidden', 'true');
    host.appendChild(caret);
    input.classList.add('has-smooth-caret');
    const state = { input, caret, el: caret, cx: null, tx: 0 };
    measureCaret(state);
    input.addEventListener('focus', () => {
        measureCaret(state);
        caret.classList.add('on');
        caretWake(state);
    });
    input.addEventListener('blur', () => {
        caret.classList.remove('on', 'moving');
        caretActive.delete(state);
        if (!caretActive.size && caretRaf) { cancelAnimationFrame(caretRaf); caretRaf = null; }
    });
    ['input', 'click', 'keyup', 'select', 'compositionupdate'].forEach(ev =>
        input.addEventListener(ev, () => caretWake(state)));
    input.addEventListener('scroll', () => caretWake(state));
}
function initSmoothCarets() {
    if (window.matchMedia('(pointer: coarse)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"], input[type="email"], textarea')
        .forEach(attachSmoothCaret);
}
function switchView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    $('view-' + name).classList.add('active');
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    $('mobile-menu').classList.add('hidden');
    if (name === 'analytics') { renderAnalytics(); requestAnimationFrame(() => renderChart()); }
    moveNavPills();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
function confirmDialog(title, body, okLabel = 'Confirm') {
    return new Promise(resolve => {
        $('confirm-title').textContent = title;
        $('confirm-body').textContent = body;
        $('confirm-ok').textContent = okLabel;
        const box = $('confirm-modal');
        let settled = false;
        const done = (v) => {
            if (settled) return;
            settled = true;
            box.classList.remove('show');
            setTimeout(() => {
                box.classList.add('hidden');
                $('confirm-ok').onclick = null;
                $('confirm-cancel').onclick = null;
                box.onclick = null;
                resolve(v);
            }, 200);
        };
        $('confirm-ok').onclick = () => done(true);
        $('confirm-cancel').onclick = () => done(false);
        box.onclick = (e) => { if (e.target === box) done(false); };
        box.classList.remove('hidden');
        void box.offsetWidth;
        requestAnimationFrame(() => box.classList.add('show'));
    });
}
function openAuth() { $('auth-modal').classList.remove('hidden'); }
function closeAuth() { $('auth-modal').classList.add('hidden'); }

document.addEventListener('DOMContentLoaded', () => {
    makeDropdown($('analytics-platform'));
    applyTheme(Store.get('theme', 'system'), false);
    // restore cached
    const cached = Store.get('cache_all', null);
    if (cached && cached.data) { ALL_CONTESTS = cached.data; renderContests(); renderTracked(); }
    const ch = Store.get('cf_history', null);
    if (ch && ch.data) CF_HISTORY = ch.data;
    const cu = Store.get('cf_user', null);
    if (cu && cu.data) CF_USER = cu.data;

    restorePlatformCaches();
    refreshAuthUI(); renderPast();

    // nav
    document.querySelectorAll('.nav-tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
    document.querySelectorAll('[data-goto]').forEach(a => a.onclick = (e) => { e.preventDefault(); switchView(a.dataset.goto); });
    const yr = $('yr');
    if (yr) yr.textContent = new Date().getFullYear();
    $('brand-home').onclick = () => switchView('contests');
    $('hamburger').onclick = () => { $('mobile-menu').classList.toggle('hidden'); moveNavPills(); };
    moveNavPills();
    wireNavHover(document.querySelector('.topnav .nav-tabs'));
    wireNavHover($('mobile-menu'));
    moveChipPill();
    initSmoothCarets();
    window.addEventListener('resize', () => { moveNavPills(); moveChipPill(); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { moveNavPills(); moveChipPill(); });
    const THEME_CYCLE = ['dark', 'light'];
    const themeBtn = $('theme-toggle');
    if (themeBtn) themeBtn.onclick = (e) => {
        const cur = Store.get('theme', 'system');
        const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1 + THEME_CYCLE.length) % THEME_CYCLE.length];
        applyTheme(next);
        if (e.detail > 0) themeBtn.blur(); // mouse users: drop focus so no ring lingers
    };

    // filters
    $('platform-filters').querySelectorAll('.chip').forEach(chip => {
        chip.onclick = () => {
            $('platform-filters').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            FILTER = chip.dataset.platform;
            renderContests(true);
            moveChipPill();
            updateRatingLines();
        };
    });
    let SEARCH_T = null;
    $('search').oninput = (e) => {
        clearTimeout(SEARCH_T);
        SEARCH_T = setTimeout(() => { QUERY = e.target.value.trim().toLowerCase(); renderContests(); }, 150);
    };
    $('eligible-only').onchange = (e) => { ELIGIBLE_ONLY = e.target.checked; ANIM_NEXT = true; fetchAllContests(); };
    $('refresh-btn').onclick = () => { fetchAllContests(); toast('Refreshing…', 'Pulling all four feeds.'); };

    // chart hover (every point shows its rating)
    const cv = $('rating-chart');
    cv.style.touchAction = 'pan-y';
    cv.addEventListener('pointermove', chartHover);
    cv.addEventListener('pointerleave', () => { CHART.hover = -1; CHART.cx = CHART.cy = null; stopHoverLoop(); hideTip(); renderChart(); });

    // analytics
    $('sync-analytics').onclick = syncAnalytics;
    $('analytics-platform').onchange = (e) => {
        ACTIVE_PLATFORM = e.target.value;
        if (handleForSite(ANALYTICS_SITES[ACTIVE_PLATFORM]) && !activeData()) syncAnalytics();
        else renderAnalytics();
    };
    $('export-csv').onclick = () => {
        if (!CF_HISTORY.length) { toast('Nothing to export', 'Sync ratings first.'); return; }
        const blob = new Blob([contestsCSV()], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = 'contestradar-history.csv'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };

    // profile + auth
    $('save-profile').onclick = () => {
        const old = user() || {};
        const next = {
            name: $('pf-name').value.trim(), cf: $('pf-cf').value.trim(),
            leetcode: $('pf-lc').value.trim(), atcoder: $('pf-ac').value.trim(), codechef: $('pf-cc').value.trim()
        };
        // Cooldown gate: block saves that change a locked handle.
        const sites = [['cf', 'Codeforces'], ['leetcode', 'LeetCode'], ['atcoder', 'AtCoder'], ['codechef', 'CodeChef']];
        const blocked = sites.filter(([k, label]) =>
            (next[k] || '') !== (old[k] || '') && (old[k] || '') !== '' && !canChangeHandle(k));
        if (blocked.length) {
            toast('Handle change locked', blocked.map(([k, label]) =>
                `${label} unlocks ${lockDate(lockTs(k) || Date.now())}`).join(' · '));
            return;
        }
        saveUser(next);
        // Stamp changed handles (first set + typo grace flow through canChangeHandle).
        const locks = getHandleLock();
        let touched = false;
        sites.forEach(([k]) => {
            if ((next[k] || '') !== (old[k] || '') && next[k]) { locks[k] = Date.now(); touched = true; }
        });
        if (touched) Store.set('handleLock', locks);
        toast('Profile saved ✓', 'Syncing all linked handles…');
        Cloud.pushQuiet();
        PLATFORM_RATINGS = { Codeforces: null, LeetCode: null, CodeChef: null, AtCoder: null };
        LC_DATA = CC_DATA = AC_DATA = null;
        fetchAllContests();
        syncAllPlatforms();
    };
    $('logout-btn').onclick = async () => {
        const yes = await confirmDialog('Log out?', 'Your synced data stays safe in the cloud. This browser will sign out.', 'Log out');
        if (!yes) return;
        if (Cloud.on && Cloud.user) { window.FB.signOut(window.FB.auth).catch(() => {}); Cloud.user = null; Cloud.profile = null; }
        Store.set('user', null); CF_USER = null; CF_HISTORY = []; LC_DATA = CC_DATA = AC_DATA = null; PLATFORM_RATINGS = { Codeforces: null, LeetCode: null, CodeChef: null, AtCoder: null }; refreshAuthUI(); renderAnalytics(); toast('Logged out', 'Local profile cleared.');
    };
    const startGoogleSignIn = () => {
        if (!Cloud.on) { openAuth(); return; } // offline: local-only modal
        try {
            const provider = new window.FB.GoogleAuthProvider();
            provider.setCustomParameters({ prompt: 'select_account' });
            window.FB.signInWithPopup(window.FB.auth, provider).catch(e => {
                toast('Google sign-in failed', (/unauthorized-domain|origin/i.test(e.message || '') ?
                    'Add this domain under Authentication → Settings → Authorized domains.' :
                    'Falling back to local profile. ' + (e.message || '')));
                openAuth();
            });
        } catch (e) { openAuth(); }
    };
    $('auth-btn').onclick = startGoogleSignIn;
    const gateBtn = $('gate-signin');
    if (gateBtn) gateBtn.onclick = startGoogleSignIn;
    $('auth-close').onclick = closeAuth;
    $('auth-modal').addEventListener('click', (e) => { if (e.target.id === 'auth-modal') closeAuth(); });
    $('auth-save').onclick = async () => {
        const name = $('auth-name').value.trim();
        const cf = $('auth-cf').value.trim() || CF_HANDLE;
        Store.set('user', {
            name: name || cf, cf,
            leetcode: $('auth-lc').value.trim(),
            atcoder: $('auth-ac').value.trim(),
            codechef: $('auth-cc').value.trim()
        });
        PLATFORM_RATINGS = { Codeforces: null, LeetCode: null, CodeChef: null, AtCoder: null };
        LC_DATA = CC_DATA = AC_DATA = null;
        const locks = getHandleLock();
        ['cf', 'leetcode', 'atcoder', 'codechef'].forEach(k => {
            if ((Store.get('user', {})[k] || '') !== '') locks[k] = Date.now();
        });
        Store.set('handleLock', locks);
        if (Cloud.user) { try { await Cloud.push(); } catch {} }
        closeAuth(); refreshAuthUI(); fetchAllContests();
        toast(`Welcome, ${name || cf}!`, 'Handles linked — syncing all platforms…');
        const results = await syncAllPlatforms();
        if (results.length) toast('Sync complete', results.map(r => (r.ok ? '✓ ' : '✗ ') + r.msg).join(' · '));
    };

    // live countdown refresh (no refetch)
    setInterval(() => { renderContests(); }, 60 * 1000);
    // chart redraw on resize
    window.addEventListener('resize', () => {
        if ($('view-analytics').classList.contains('active')) renderChart();
    });

    // boot
    restorePlatformCaches();
    if (window.FB && window.FB.ready) initCloudAuth();
    else {
        document.addEventListener('fb-ready', () => initCloudAuth(), { once: true });
        setTimeout(() => initCloudAuth(), 4000); // module blocked/offline: stay local-only
    }
    fetchAllContests();
    ACTIVE_PLATFORM = ($('analytics-platform') && $('analytics-platform').value) || 'codeforces';
    if (handleForSite(ANALYTICS_SITES[ACTIVE_PLATFORM]) && !activeData()) syncAnalytics(); else renderAnalytics();
    // Deep links from doc pages (index.html#analytics etc.)
    const deep = (location.hash || '').replace('#', '');
    if (['contests', 'analytics', 'profile'].includes(deep)) switchView(deep);
});

// Initial fetch + hourly refresh
fetchAllContests();
setInterval(fetchAllContests, 60 * 60 * 1000);