/* Anonymous cheer wall for pkudzia.github.io/everesting.
   GET  -> newest 200 posts as JSON
   POST -> { name?, message?, photo? (data URL), website (honeypot) }
   Posts and photos live in Vercel Blob; delete anything from the dashboard. */

import { list, put } from '@vercel/blob';

const ORIGINS = ['https://pkudzia.github.io', 'http://localhost:8801'];
const hits = new Map(); // best-effort per-instance rate limit

export default async function handler(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes(origin) ? origin : ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    const { blobs } = await list({ prefix: 'comments/', limit: 500 });
    // Pathnames embed (1e13 - timestamp), so ascending order = newest first.
    blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));
    const posts = await Promise.all(
      blobs.slice(0, 200).map(async (b) => {
        try {
          const r = await fetch(b.url);
          return r.ok ? await r.json() : null;
        } catch {
          return null;
        }
      })
    );
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
    return res.status(200).json(posts.filter(Boolean));
  }

  if (req.method === 'POST') {
    const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0];
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    if (recent.length >= 5) return res.status(429).json({ error: 'Easy there — five posts a minute, max.' });
    recent.push(now);
    hits.set(ip, recent);

    const { name = '', message = '', photo = null, website = '' } = req.body || {};
    if (website) return res.status(400).json({ error: 'No bots.' }); // honeypot field
    const msg = String(message).trim().slice(0, 500);
    const who = String(name).trim().slice(0, 40) || 'Anonymous';
    if (!msg && !photo) return res.status(400).json({ error: 'Say something or show something.' });

    const id = `${String(1e13 - now).padStart(13, '0')}-${Math.random().toString(36).slice(2, 8)}`;

    let photoUrl = null;
    if (photo) {
      const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(photo);
      if (!m) return res.status(400).json({ error: 'That does not look like a photo.' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 4_000_000) return res.status(413).json({ error: 'Photo too big (4 MB max).' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const b = await put(`photos/${id}.${ext}`, buf, {
        access: 'public',
        contentType: `image/${m[1]}`,
        addRandomSuffix: false,
      });
      photoUrl = b.url;
    }

    const post = { name: who, message: msg, photo: photoUrl, time: new Date().toISOString() };
    await put(`comments/${id}.json`, JSON.stringify(post), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
    });
    return res.status(200).json(post);
  }

  return res.status(405).end();
}
