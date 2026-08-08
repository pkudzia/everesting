/* Live tracking was retired after the event. This endpoint intentionally
   accepts no location data or progress updates. */

const ALLOWED_ORIGINS = ['https://pkudzia.github.io'];

export default function handler(req, res) {
  const origin = req.headers.origin;
  res.setHeader(
    'Access-Control-Allow-Origin',
    ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  );
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(410).json({ error: 'Live tracking has ended.' });
}
