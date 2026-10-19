const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const DB_PATH = process.env.ECOTRACK_DB || path.join(ROOT, 'data', 'db.json');
const UPLOAD_DIR = process.env.ECOTRACK_UPLOADS || path.join(ROOT, 'uploads');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sessions = new Map();
const workerSessions = new Map();
const workerUnlockAttempts = new Map();
const hash = (password, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') });
const workerAccessPassword = hash(process.env.ECOTRACK_WORKER_PASSWORD || '4321');
const verify = (password, record) => {
  try { return crypto.timingSafeEqual(Buffer.from(hash(password, record.salt).hash, 'hex'), Buffer.from(record.hash, 'hex')); } catch { return false; }
};

function initializeDb() {
  if (fs.existsSync(DB_PATH)) {
    const existingDb = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    existingDb.eventAttendees ||= [];
    existingDb.pins ||= [];
    return existingDb;
  }
  const demo = { id: 'u_demo', name: 'Aarav Kumar', email: 'demo@ecotrack.in', country: 'India', role: 'citizen', points: 12, language: null, createdAt: new Date().toISOString(), password: hash('Demo123!') };
  const team = { id: 'u_team', name: 'Chennai Clean Team', email: 'team@ecotrack.in', country: 'India', role: 'department', points: 0, language: 'en', createdAt: new Date().toISOString(), password: hash('Clean123!') };
  const db = {
    users: [demo, team],
    reports: [
      { id: 'RPT-1042', userId: demo.id, reporterName: demo.name, wasteType: 'Mixed household waste', quantity: 'Medium', binFill: 'medium', description: 'Overflowing bags beside the bus stop. Needs a collection before the evening rush.', address: '18 Marina Beach Road, Chennai, Tamil Nadu', lat: 13.0524, lng: 80.2824, media: [], status: 'in-progress', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(), pointsAwarded: false },
      { id: 'RPT-0988', userId: demo.id, reporterName: demo.name, wasteType: 'Plastic & packaging', quantity: 'Low', binFill: 'low', description: 'Litter near the park entrance has been collected.', address: 'Semmozhi Poonga, Chennai, Tamil Nadu', lat: 13.0501, lng: 80.2504, media: [], status: 'cleaned', createdAt: new Date(Date.now() - 1000 * 60 * 60 * 42).toISOString(), pointsAwarded: true }
    ],
    events: [
      { id: 'EVT-001', title: 'Marina Beach Clean-up', category: 'Community clean-up', description: 'Join your neighbors for a cleaner coastline. Gloves and collection bags provided.', address: 'Marina Beach, Chennai, Tamil Nadu', lat: 13.0500, lng: 80.2824, startsAt: new Date(Date.now() + 86400000 * 2).toISOString(), organizer: 'Chennai Municipal Team', createdAt: new Date().toISOString() }
    ],
    eventAttendees: [],
    pins: [],
    leaderboardSamples: [
      { name: 'Priya S.', country: 'India', points: 248, badge: '🌱' }, { name: 'Noah M.', country: 'United States', points: 221, badge: '♻️' },
      { name: 'Mei L.', country: 'Singapore', points: 197, badge: '🌿' }, { name: 'Fatima A.', country: 'United Arab Emirates', points: 184, badge: '🌼' },
      { name: 'Daniel K.', country: 'Kenya', points: 162, badge: '🌳' }
    ]
  };
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  return db;
}
let db = initializeDb();
function saveDb() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
const publicUser = ({ password, ...user }) => user;
const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const getUser = req => { const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const id = sessions.get(token); return db.users.find(user => user.id === id); };
const getWorkerSession = req => { const token = req.headers['x-worker-token']; const session = typeof token === 'string' ? workerSessions.get(token) : null; if (!session) return null; if (session.expiresAt <= Date.now()) { workerSessions.delete(token); return null; } return { ...session, token }; };
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 13 * 1024 * 1024) { reject(Object.assign(new Error('Request is too large. Please use a smaller file.'), { status: 413 })); req.destroy(); return; } raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('Invalid request data.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const cleanString = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fail = (res, status, error) => send(res, status, { error });

async function handleApi(req, res, url) {
  const method = req.method;
  if (method === 'POST' && url.pathname === '/api/register') {
    const body = await bodyJson(req);
    const name = cleanString(body.name, 80); const email = cleanString(body.email, 160).toLowerCase(); const password = typeof body.password === 'string' ? body.password : '';
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return fail(res, 400, 'Enter your name, a valid email, and a password with at least 8 characters.');
    if (db.users.some(user => user.email === email)) return fail(res, 409, 'An account with that email already exists.');
    const user = { id: `u_${crypto.randomUUID()}`, name, email, country: cleanString(body.country, 80) || 'India', role: 'citizen', points: 0, language: 'en', createdAt: new Date().toISOString(), password: hash(password) };
    db.users.push(user); saveDb(); const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
    return send(res, 201, { token, user: publicUser(user) });
  }
  if (method === 'POST' && url.pathname === '/api/login') {
    const body = await bodyJson(req); const email = cleanString(body.email, 160).toLowerCase(); const user = db.users.find(item => item.email === email);
    if (!user || !verify(typeof body.password === 'string' ? body.password : '', user.password)) return fail(res, 401, 'Email or password is incorrect.');
    const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
    return send(res, 200, { token, user: publicUser(user) });
  }
  const user = getUser(req);
  const workerToken = getWorkerSession(req);
  if (method === 'GET' && url.pathname === '/api/worker/data') {
    if (!user || !workerToken || workerToken.userId !== user.id) return fail(res, 401, 'Worker access is locked. Enter the staff passcode again.');
    const users = db.users.map(publicUser).map(person => ({ id: person.id, name: person.name, email: person.email, country: person.country, role: person.role, points: person.points, createdAt: person.createdAt }));
    const reports = db.reports.map(report => ({ ...report, reporterEmail: db.users.find(person => person.id === report.userId)?.email || '' })).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, { users, reports });
  }
  const workerStatusMatch = url.pathname.match(/^\/api\/worker\/reports\/([\w-]+)\/status$/);
  if (method === 'PATCH' && workerStatusMatch) {
    if (!user || !workerToken || workerToken.userId !== user.id) return fail(res, 401, 'Worker access is locked. Enter the staff passcode again.');
    const body = await bodyJson(req); const report = db.reports.find(item => item.id === workerStatusMatch[1]);
    if (!report) return fail(res, 404, 'Report not found.');
    if (!['received', 'in-progress', 'cleaned'].includes(body.status)) return fail(res, 400, 'Choose a valid report status.');
    report.status = body.status;
    if (body.status === 'cleaned' && !report.pointsAwarded) { report.pointsAwarded = true; const reporter = db.users.find(person => person.id === report.userId); if (reporter) reporter.points += 4; }
    saveDb();
    return send(res, 200, { report: { ...report, reporterEmail: db.users.find(person => person.id === report.userId)?.email || '' } });
  }
  if (method === 'POST' && url.pathname === '/api/worker/lock') {
    if (!user || !workerToken || workerToken.userId !== user.id) return fail(res, 401, 'Worker access is already locked.');
    workerSessions.delete(workerToken.token); return send(res, 200, { ok: true });
  }
  if (method === 'POST' && url.pathname === '/api/worker/unlock') {
    if (!user) return fail(res, 401, 'Please sign in before opening the worker menu.');
    const ip = req.socket.remoteAddress || 'unknown'; const attempt = workerUnlockAttempts.get(ip);
    if (attempt && attempt.blockedUntil > Date.now()) return fail(res, 429, 'Too many incorrect passcodes. Please try again in 15 minutes.');
    const body = await bodyJson(req);
    if (typeof body.password !== 'string' || !verify(body.password, workerAccessPassword)) {
      const failures = attempt && attempt.blockedUntil <= Date.now() ? 0 : (attempt?.failures || 0);
      const next = failures + 1; workerUnlockAttempts.set(ip, { failures: next, blockedUntil: next >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
      return fail(res, 403, 'That worker passcode is incorrect.');
    }
    workerUnlockAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex'); workerSessions.set(token, { userId: user.id, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
    return send(res, 200, { workerToken: token, expiresIn: 8 * 60 * 60 });
  }
  if (method === 'POST' && url.pathname === '/api/logout') { const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, ''); const id = sessions.get(token); sessions.delete(token); for (const [workerSession, details] of workerSessions) if (details.userId === id) workerSessions.delete(workerSession); return send(res, 200, { ok: true }); }
  if (!user) return fail(res, 401, 'Please sign in to continue.');
  if (method === 'GET' && url.pathname === '/api/bootstrap') {
    const visibleReports = db.reports.filter(report => report.userId === user.id);
    const leaderboard = [...db.leaderboardSamples, ...db.users.filter(person => person.role === 'citizen').map(person => ({ name: person.name, country: person.country, points: person.points, badge: person.points >= 100 ? '🌳' : '🌱' }))].sort((a, b) => b.points - a.points);
    db.eventAttendees ||= [];
    db.pins ||= [];
    const events = db.events.sort((a,b) => a.startsAt.localeCompare(b.startsAt)).map(event => ({ ...event, attendeeCount: db.eventAttendees.filter(attendee => attendee.eventId === event.id).length, attending: db.eventAttendees.some(attendee => attendee.eventId === event.id && attendee.userId === user.id) }));
    const visiblePins = db.pins.filter(pin => pin.userId === user.id || pin.visibility === 'public').map(pin => ({ ...pin, isOwner: pin.userId === user.id }));
    return send(res, 200, { user: publicUser(user), reports: visibleReports.sort((a,b) => b.createdAt.localeCompare(a.createdAt)), events, pins: visiblePins, leaderboard });
  }
  if (method === 'PATCH' && url.pathname === '/api/profile') {
    const body = await bodyJson(req); const name = cleanString(body.name, 80); const language = ['en', 'ta', 'hi'].includes(body.language) ? body.language : null;
    if (name && name.length < 2) return fail(res, 400, 'Name must be at least 2 characters.');
    if (name) user.name = name; if (language) user.language = language; saveDb();
    return send(res, 200, { user: publicUser(user) });
  }
  if (method === 'POST' && url.pathname === '/api/reports') {
    const body = await bodyJson(req);
    if (user.role !== 'citizen') return fail(res, 403, 'Only community members can submit reports.');
    const address = cleanString(body.address, 300); const wasteType = cleanString(body.wasteType, 80); const quantity = cleanString(body.quantity, 20); const binFill = cleanString(body.binFill, 20);
    if (!address || !wasteType || !['Low', 'Medium', 'High'].includes(quantity) || !['low', 'medium', 'full'].includes(binFill)) return fail(res, 400, 'Add a location, waste type, quantity, and bin fill level.');
    const lat = Number(body.lat); const lng = Number(body.lng);
    if (body.lat === undefined || body.lat === '' || body.lng === undefined || body.lng === '' || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return fail(res, 400, 'Choose a valid report location on the map or using GPS.');
    if (binFill === 'full' && cleanString(body.description, 1000).length < 10) return fail(res, 400, 'Please describe the full bin or waste situation (at least 10 characters).');
    if (!Array.isArray(body.media) || body.media.length < 1) return fail(res, 400, 'Please upload at least one photo or video.');
    const media = [];
    try {
      for (const item of body.media.slice(0, 4)) {
        if (!item || typeof item.data !== 'string' || item.data.length > 8 * 1024 * 1024) throw new Error('Each upload must be under 6 MB.');
        const match = item.data.match(/^data:(image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm|quicktime));base64,([A-Za-z0-9+/=]+)$/);
        if (!match) throw new Error('Use JPG, PNG, WEBP, MP4, or WEBM files.');
        const buffer = Buffer.from(match[2], 'base64'); if (buffer.length > 6 * 1024 * 1024) throw new Error('Each upload must be under 6 MB.');
        const ext = ({ 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif', 'video/mp4':'mp4', 'video/webm':'webm', 'video/quicktime':'mov' })[match[1]];
        const fileName = `${crypto.randomUUID()}.${ext}`; fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer); media.push({ url: `/uploads/${fileName}`, type: match[1].startsWith('video/') ? 'video' : 'image', name: cleanString(item.name, 100) || fileName });
      }
    } catch (error) { return fail(res, 400, error.message); }
    const report = { id: `RPT-${String(Date.now()).slice(-6)}`, userId: user.id, reporterName: user.name, wasteType, quantity, binFill, description: cleanString(body.description, 1000), address, lat, lng, media, status: 'received', createdAt: new Date().toISOString(), pointsAwarded: false };
    db.reports.push(report); saveDb(); return send(res, 201, { report });
  }
  const pinMatch = url.pathname.match(/^\/api\/pins\/([\w-]+)$/);
  if (method === 'POST' && url.pathname === '/api/pins') {
    const body = await bodyJson(req);
    const title = cleanString(body.title, 100);
    const description = cleanString(body.description, 500);
    const lat = Number(body.lat); const lng = Number(body.lng);
    const visibility = body.visibility === 'public' ? 'public' : 'private';
    if (title.length < 2 || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return fail(res, 400, 'Add a place name and a valid location on the map.');
    db.pins ||= [];
    const pin = { id: `PIN-${crypto.randomUUID().slice(0, 8)}`, userId: user.id, ownerName: user.name, title, description, lat, lng, visibility, createdAt: new Date().toISOString() };
    db.pins.push(pin); saveDb(); return send(res, 201, { pin: { ...pin, isOwner: true } });
  }
  if (pinMatch && method === 'PATCH') {
    const pin = (db.pins || []).find(item => item.id === pinMatch[1]);
    if (!pin) return fail(res, 404, 'Saved place not found.');
    if (pin.userId !== user.id) return fail(res, 403, 'You can only change privacy for your own saved places.');
    const body = await bodyJson(req);
    if (!['private', 'public'].includes(body.visibility)) return fail(res, 400, 'Choose private or public visibility.');
    pin.visibility = body.visibility; saveDb(); return send(res, 200, { pin: { ...pin, isOwner: true } });
  }
  if (pinMatch && method === 'DELETE') {
    const index = (db.pins || []).findIndex(item => item.id === pinMatch[1]);
    if (index === -1) return fail(res, 404, 'Saved place not found.');
    if (db.pins[index].userId !== user.id) return fail(res, 403, 'You can only delete your own saved places.');
    db.pins.splice(index, 1); saveDb(); return send(res, 200, { ok: true });
  }
  const eventAttendeesMatch = url.pathname.match(/^\/api\/events\/([\w-]+)\/attend$/);
  if (method === 'POST' && eventAttendeesMatch) {
    const event = db.events.find(item => item.id === eventAttendeesMatch[1]);
    if (!event) return fail(res, 404, 'This event could not be found.');
    db.eventAttendees ||= [];
    let attendee = db.eventAttendees.find(item => item.eventId === event.id && item.userId === user.id);
    if (!attendee) { attendee = { eventId: event.id, userId: user.id, name: user.name, joinedAt: new Date().toISOString() }; db.eventAttendees.push(attendee); saveDb(); }
    const attendees = db.eventAttendees.filter(item => item.eventId === event.id);
    return send(res, 200, { eventId: event.id, attending: true, attendeeCount: attendees.length });
  }
  if (method === 'POST' && url.pathname === '/api/events') {
    const body = await bodyJson(req); const title = cleanString(body.title, 120); const address = cleanString(body.address, 300); const startsAt = new Date(body.startsAt);
    if (title.length < 3 || !address || Number.isNaN(startsAt.valueOf()) || startsAt <= new Date()) return fail(res, 400, 'Add an event title, valid future date and time, and address.');
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return fail(res, 400, 'Enter valid map coordinates for the event.');
    const event = { id: `EVT-${crypto.randomUUID().slice(0, 8)}`, title, category: cleanString(body.category, 80) || 'Community clean-up', description: cleanString(body.description, 800), address, lat, lng, startsAt: startsAt.toISOString(), organizer: user.name, createdAt: new Date().toISOString() };
    db.events.push(event); saveDb(); return send(res, 201, { event });
  }
  const statusMatch = url.pathname.match(/^\/api\/reports\/([\w-]+)\/status$/);
  if (method === 'PATCH' && statusMatch) {
    return fail(res, 403, 'Open the password-protected Workers menu to update report status.');
    const body = await bodyJson(req); const report = db.reports.find(item => item.id === statusMatch[1]);
    if (!report) return fail(res, 404, 'Report not found.');
    if (!['received', 'in-progress', 'cleaned'].includes(body.status)) return fail(res, 400, 'Choose a valid report status.');
    report.status = body.status;
    if (body.status === 'cleaned' && !report.pointsAwarded) { report.pointsAwarded = true; const reporter = db.users.find(person => person.id === report.userId); if (reporter) reporter.points += 4; }
    saveDb(); return send(res, 200, { report });
  }
  return fail(res, 404, 'This endpoint was not found.');
}

const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp4':'video/mp4', '.webm':'video/webm' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); } catch (error) { if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' }); }
    return;
  }
  const filePath = url.pathname.startsWith('/uploads/')
    ? path.join(UPLOAD_DIR, path.basename(url.pathname))
    : path.resolve(ROOT, 'public', url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`);
  if (!filePath.startsWith(`${path.resolve(ROOT)}${path.sep}`)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (error, contents) => {
    if (error) { res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Cache-Control': url.pathname.startsWith('/uploads/') ? 'private, max-age=3600' : 'no-cache' }); res.end(contents);
  });
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`EcoTrack listening on http://0.0.0.0:${port}`));
