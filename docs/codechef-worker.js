// ContestRadar CodeChef proxy — paste into a Cloudflare Worker → Save and deploy.
// Turns a public CodeChef profile page into clean contest-history JSON with
// open CORS headers, so the static frontend can graph it. Free tier is plenty.
export default {
  async fetch(req) {
    const url = new URL(req.url);

    // Friendly landing page for the bare URL (this is an API, not a website)
    if (!url.searchParams.has('handle')) {
      return new Response('ContestRadar CodeChef proxy is running. Use ?handle=USERNAME', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const handle = (url.searchParams.get('handle') || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(handle))
      return Response.json({ error: 'bad handle', received: handle }, { status: 400 });

    const upstream = await fetch(`https://www.codechef.com/users/${handle}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!upstream.ok)
      return Response.json({ error: 'codechef unreachable' }, { status: 502 });

    const html = await upstream.text();
    const m = html.match(/var\s+all_rating\s*=\s*(\[.*?\])\s*;/s);
    if (!m)
      return Response.json({ error: 'no history found' }, { status: 404 });

    let arr;
    try {
      arr = JSON.parse(m[1]);
    } catch {
      return Response.json({ error: 'parse failed' }, { status: 502 });
    }

    const points = arr
      .filter(x => x && x.rating != null)
      .map(x => ({
        date: x.end_date || `${x.getyear}-${x.getmonth}-${x.getday}`,
        rating: Number(x.rating),
        rank: x.rank != null ? Number(x.rank) : null,
        name: x.name || x.code || 'CodeChef contest',
      }));

    return Response.json(
      {
        handle,
        current: points.length ? points[points.length - 1].rating : null,
        points,
      },
      {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        },
      }
    );
  }
};
