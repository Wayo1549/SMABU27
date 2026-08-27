/**
 * ====================================================================
 * server.js
 * ====================================================================
 * This is the backend entry point for the Dual-Screen Photobooth
 * System. It has exactly two jobs:
 *
 *   1. HTTP STATIC FILE SERVER
 *      Serve the frontend (public/index.html, style.css, script.js)
 *      to any browser that requests it — this is what makes
 *      `http://localhost:3000/index.html?role=admin` work.
 *
 *   2. REAL-TIME MESSAGE BROKER (Socket.io)
 *      Sit in the middle of two browser tabs/windows — the "Admin"
 *      controller and the "Customer" display — and relay events
 *      between them the instant they happen, so both screens feel
 *      like one seamless system even though they're two completely
 *      separate page loads (possibly on two different devices).
 *
 * Think of this file as a switchboard operator: it doesn't know or
 * care about pixels, cameras, or CSS — it just forwards messages
 * from whoever sent them to whoever should receive them.
 * ====================================================================
 *
 * [หมายเหตุการรีแฟคเตอร์ - HYBRID LOCAL-GLOBAL] อ่านก่อน
 * --------------------------------------------------------------
 * ไฟล์นี้ยังคงรันอยู่ "ในเครื่อง" (localhost:3000) เหมือนเดิมทุก
 * ประการ — ไม่มีการย้ายไปรันบน cloud ใดๆ สิ่งที่ทำให้มันเข้าถึงได้
 * จากอินเทอร์เน็ตภายนอก (เพื่อให้มือถือแขกสแกน QR แล้วเปิดได้จริง)
 * คือ start.js ที่เปิด Cloudflare Quick Tunnel (ผ่าน cloudflared.exe)
 * ชี้เข้ามาที่ localhost:3000 นี้ แล้วส่ง URL สาธารณะที่ได้มาเข้าไป
 * ทาง environment variable PUBLIC_BASE_URL — ตัวแปรนี้ถูกใช้อยู่แล้ว
 * ด้านล่างในจุดที่สร้างลิงก์ QR code (ดู POST /api/strip) จึงไม่ต้อง
 * แก้อะไรเพิ่มตรงนั้น
 *
 * ระบบ "ลบข้อมูลอัตโนมัติภายใน 24 ชั่วโมง" (24-Hour Auto-Deletion
 * Pipeline) ที่โจทย์ต้องการ มีอยู่แล้วในไฟล์นี้ตั้งแต่ก่อนรีแฟคเตอร์
 * ครั้งนี้ — คือ sessionStore (Map ในหน่วยความจำ) + SESSION_TTL_MS
 * (86,400,000 ms = 24 ชม.) + setInterval() ที่กวาดล้าง session
 * หมดอายุเป็นระยะ (ดูรายละเอียดทั้งหมดถัดจากนี้) จึงไม่ต้องเขียน
 * ระบบใหม่ ในรอบนี้แค่ปรับให้ log ชัดเจนขึ้นเวลามีการลบเกิดขึ้นจริง
 * เพื่อให้ debug ง่ายขึ้นตอนรันจริงหน้างาน
 * ==================================================================== */

// --------------------------------------------------------------------
// IMPORTS
// --------------------------------------------------------------------
// "path" is a built-in Node.js module for working with filesystem
// paths in a cross-platform way (so this works the same on Windows,
// macOS, and Linux instead of hardcoding slashes).
const path = require('path');

// "express" is our web framework — see package.json comments for why.
const express = require('express');

// "http" is Node's built-in HTTP server module. We need the *raw*
// http.Server object (not just the Express app) because Socket.io
// has to attach itself directly to the underlying server in order to
// intercept the WebSocket upgrade handshake.
const http = require('http');

// Socket.io's server-side class. We destructure "Server" out of the
// package and will instantiate it around our http server below.
const { Server } = require('socket.io');

// Node's built-in crypto module — used below purely for
// crypto.randomUUID(), which generates the unique per-session ID
// baked into every QR download URL (the "Unique Refresh" requirement:
// no two sessions can ever produce the same URL, so a customer can
// never accidentally scan and receive the previous guest's photo).
const crypto = require('crypto');

// Node's built-in fs/promises module — ใช้เขียนไฟล์รูป/วิดีโอของแต่ละ
// เซสชันลงดิสก์โดยตรง (เปลี่ยนจาก Google Drive API มาเป็น Local
// Storage แล้ว) เลือกใช้ fs/promises แทน fs แบบ callback/sync เพื่อ
// ให้ await ได้ตรงไปตรงมา และไม่บล็อก event loop ระหว่างเขียนไฟล์
// ขนาดใหญ่อย่างวิดีโอ
const fsp = require('fs/promises');

// --------------------------------------------------------------------
// APP / SERVER / SOCKET.IO BOOTSTRAPPING
// --------------------------------------------------------------------

// Create the Express application. This object is where we register
// routes and middleware (like our static file server below).
const app = express();

// Wrap the Express app in a plain Node http.Server. Express apps are
// technically just request-handler functions; http.createServer()
// turns that function into an actual server that can accept TCP
// connections. We need this explicit wrapping step (instead of the
// usual `app.listen(...)`) so that Socket.io can hook into the SAME
// server instance and share the same port.
const server = http.createServer(app);

// Attach Socket.io to our http server. From this point on, `io`
// understands both:
//   - normal HTTP requests (handled by Express, e.g. GET /index.html)
//   - WebSocket upgrade requests (handled by Socket.io, e.g. the
//     persistent connection each browser tab opens for real-time
//     events)
// They coexist on the same port because Socket.io inspects the
// request path (default: /socket.io/*) and only intercepts requests
// meant for it, letting everything else fall through to Express.
const io = new Server(server, {
  // Socket.io payloads default to a fairly small size limit. Because
  // we're relaying base64-encoded PNG image data through socket
  // events (full-resolution captured photos via 'admin-captured-photo'
  // and 'export-complete'/'broadcast-session-checkout'), we raise
  // this ceiling so a captured photo never gets silently rejected.
  //
  // [เปลี่ยน] คอมเมนต์เดิมพูดถึง "webcam frames" (เฟรมพรีวิวสด) ด้วย
  // — ตอนนี้ไม่มีเฟรมพรีวิวสดวิ่งผ่าน socket แล้ว (ดูการลบ
  // 'sync-camera-state' ด้านล่าง) เหลือแค่รูปที่ถ่ายเสร็จแล้ว
  // (captured photo) เท่านั้นที่ยังส่งผ่านทางนี้ ค่า limit เดิม
  // (5MB) ยังเหมาะสมและไม่ต้องปรับ เพราะรูป PNG เต็มความละเอียด 1
  // รูปยังคงมีขนาดไม่เกินนี้ตามปกติ
  maxHttpBufferSize: 5 * 1024 * 1024 // 5 MB per message
});

// Read the port from an environment variable if one is set (common
// in hosting platforms like Heroku/Render), otherwise default to
// 3000 for local development.
const PORT = process.env.PORT || 3000;

// --------------------------------------------------------------------
// STATIC FRONTEND SERVING
// --------------------------------------------------------------------
// express.static() is built-in Express middleware that maps a
// filesystem folder directly onto URL paths. Because we point it at
// the "public" directory, a request for:
//     GET /index.html
//     GET /style.css
//     GET /script.js
// is automatically resolved to the matching file inside public/,
// with zero custom route code needed on our part.
//
// path.join(__dirname, 'public') builds an absolute path to the
// "public" folder that sits next to this server.js file, regardless
// of what directory the `node` command was run from.
app.use(express.static(path.join(__dirname, 'public')));

// Parses incoming JSON request bodies (req.body) for our new
// POST /api/strip endpoint below. limit:'10mb' gives headroom since
// a base64-encoded PNG strip is roughly 33% larger than its raw byte
// size and can run several hundred KB.
app.use(express.json({ limit: '10mb' }));

// A tiny JSON health-check endpoint — useful for confirming the
// server is alive (e.g. from a monitoring tool or just curling it
// manually) and for a quick sanity check on how many sockets are
// currently connected.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', connectedClients: io.engine.clientsCount });
});


// --------------------------------------------------------------------
// PHOTO SESSION STORAGE: STRIP + 3 INDIVIDUAL PHOTOS, ONE SESSION ID
// --------------------------------------------------------------------
// แทนที่ "stripStore" แบบรูปเดียวเดิม ด้วยระบบเก็บแบบ session: หนึ่ง
// ID เฉพาะตัวตอนนี้จับคู่กับภาพ 4 ภาพ (strip ที่เสร็จแล้ว บวกกับ
// รูปแต่ละใบทั้ง 3 รูป) เพราะหน้า landing page download.html ของ
// ลูกค้าต้องแสดงและเสนอทั้ง 4 ภาพแยกกัน (สไลด์โชว์ของรูปทั้ง 3 +
// grid ดาวน์โหลด 4 ภาพ)
//
// ในหน่วยความจำเท่านั้น (Map) ตั้งใจให้เป็นแบบนี้สำหรับ prototype
// บูธเดียว — sessions -> { strip: {mimeType,buffer},
// photos: [3x {mimeType,buffer}], createdAt } สำหรับการ deploy จริง
// ที่มีหลายบูธ/production ให้เปลี่ยนไปใช้ file/object storage จริง
// (disk, S3 ฯลฯ) บวกกับแถวฐานข้อมูลต่อ session แทน — in-memory Map
// จะหายไปทุกครั้งที่รีสตาร์ทเซิร์ฟเวอร์ และไม่รองรับการขยายข้าม
// server process หลายตัว
const sessionStore = new Map();

// ลิงก์ session ที่สร้างขึ้นจะใช้งานได้นานแค่ไหนก่อนถูกลบออกจาก
// หน่วยความจำ — ครอบคลุมกรณีแขกสแกนหลังจากมาเยือนไปนานพอสมควร
// โดยไม่ปล่อยให้ session เก่าสะสมตลอดไปในงานที่ยาวนาน
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 ชั่วโมง

// Helper เล็กๆ: แปลง string "data:image/png;base64,...." ให้เป็น
// { mimeType, buffer } หรือ null ถ้า string นั้นไม่ใช่ data URL ที่
// ถูกต้อง ใช้ทั้งกับ strip และรูปแต่ละใบทั้ง 3 ด้านล่าง
function decodeDataUrl(dataUrl) {
  const match = typeof dataUrl === 'string' &&
    dataUrl.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// POST /api/strip
// ใครเรียกมัน: Admin controller ครั้งเดียวต่อการจบเซสชัน burst
//           หนึ่งครั้ง ทันทีที่กด "Export to Frame"
// BODY:      { stripDataUrl: "data:image/png;base64,....",
//              photoDataUrls: [ "data:image/png;base64,...", ... x3 ] }
// RESPONSE:  { id, url } — url ชี้ไปยังหน้า LANDING PAGE สำหรับ
//           ดาวน์โหลด (download.html?session=<id>) ไม่ใช่รูปดิบ —
//           นี่คือสิ่งที่ถูก QR-encode ที่ frontend และเป็นสิ่งที่
//           download.html อ่านกลับออกมาผ่าน URLSearchParams
app.post('/api/strip', (req, res) => {
  const stripDecoded = decodeDataUrl(req.body && req.body.stripDataUrl);
  const photoDataUrls = (req.body && req.body.photoDataUrls) || [];

  if (!stripDecoded || !Array.isArray(photoDataUrls) || photoDataUrls.length !== 3) {
    return res.status(400).json({ error: 'Expected stripDataUrl and exactly 3 photoDataUrls' });
  }

  const decodedPhotos = photoDataUrls.map(decodeDataUrl);
  if (decodedPhotos.some((p) => !p)) {
    return res.status(400).json({ error: 'One or more photoDataUrls were invalid' });
  }

  // crypto.randomUUID() — การรับประกัน "unique refresh" เหมือนเดิม:
  // ทุกเซสชันจะได้ ID ของตัวเองที่ไม่มีวันซ้ำ ดังนั้นลิงก์ของมัน
  // (และ QR code) จะไม่มีทางชนกับ session ของลูกค้าคนก่อนหน้าเลย
  const id = crypto.randomUUID();
  sessionStore.set(id, {
    strip: stripDecoded,
    photos: decodedPhotos,
    createdAt: Date.now()
  });

  // สร้าง URL แบบเต็มโดยใช้ host ที่ request นี้เข้ามาจริงๆ (ไม่ใช่
  // hardcode "localhost") เพื่อให้เข้าถึงได้จริงจากมือถือในเครือข่าย
  // เดียวกัน / โดเมนที่ deploy จริง
const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;

const url = `${baseUrl}/download.html?session=${id}`;

  console.log(`[session] stored ${id} (strip + 3 photos) -> ${url}`);
  res.json({ id, url });
});

// PUT /api/session-video/:id
// ==============================================================
// [ใหม่] รับวิดีโอสไลด์โชว์ (MP4/WebM) ที่ฝั่ง download.html สร้าง
// เสร็จแล้วผ่าน MediaRecorder ส่งกลับมาเก็บใน sessionStore
// ==============================================================
// หมายเหตุสำคัญ: endpoint นี้จำเป็นสำหรับให้ปุ่ม "บันทึกรูปและ
// วิดีโอลงไดร์ฟ" อัปโหลดวิดีโอได้จริง — ของเดิม (ก่อนแก้ครั้งนี้)
// ไม่มีช่องทางให้วิดีโอที่สร้างบนมือถือแขกส่งกลับมาที่ server เลย
// จึง "ต้องแก้ download.html เพิ่มอีก 1 จุด" ให้เรียก endpoint นี้
// (fetch PUT พร้อม Content-Type ตรงกับ MediaRecorder เช่น
// 'video/webm' หรือ 'video/mp4') ทันทีหลังบันทึกวิดีโอเสร็จ —
// ไม่เช่นนั้น entry.video จะยังคงเป็น undefined และปุ่ม backup จะ
// ยังคงส่งแค่ strip + 3 รูปเหมือนเดิม (videoIncluded: false)
//
// ใช้ express.raw() เฉพาะ route นี้ (ไม่ใช่ express.json() ตัวกลาง
// ของทั้งแอป) เพราะ body เป็นไบต์วิดีโอดิบ ไม่ใช่ JSON — limit ตั้ง
// ไว้ที่ 50mb เผื่อคลิปสไลด์โชว์ความยาวสักครู่
app.put(
  '/api/session-video/:id',
  express.raw({ type: () => true, limit: '50mb' }),
  (req, res) => {
    const entry = sessionStore.get(req.params.id);
    if (!entry) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Empty or invalid video body' });
    }

    const mimeType = (req.headers['content-type'] || 'video/mp4').split(';')[0].trim();

    entry.video = { mimeType, buffer: req.body };

    console.log(`[session] video stored for session ${req.params.id} (${mimeType}, ${req.body.length} bytes)`);
    res.json({ ok: true, bytes: req.body.length });
  }
);

// POST /api/backup-to-drive
// ==============================================================
// [เปลี่ยนระบบจัดเก็บ] บันทึกรูป+วิดีโอของเซสชันปัจจุบันลงดิสก์ในเครื่อง
// (Local Storage) แทน Google Drive เมื่อ Admin กดปุ่ม "บันทึกรูปและ
// วิดีโอลงไดร์ฟ" — endpoint path เดิม (`/api/backup-to-drive`) และ
// path ฝั่ง frontend (script.js) ไม่ต้องแก้อะไรเลย เปลี่ยนแค่ปลายทาง
// การจัดเก็บที่ฝั่ง server เท่านั้น
// ==============================================================
// videoIncluded ตอบตามความจริงเสมอ: true เฉพาะเมื่อ entry.video มี
// ข้อมูลอยู่จริง (คือ download.html ฝั่งแขกได้ PUT วิดีโอกลับมาที่
// PUT /api/session-video/:id แล้วเท่านั้น) — ถ้าแขกยังไม่ได้เปิด
// download.html หรือยังไม่กด "บันทึกวิดีโอ" ฝั่งนั้น entry.video จะ
// ยังไม่มี และ backup รอบนี้จะบันทึกแค่ strip + 3 รูป พร้อม
// videoIncluded: false — ไม่มีการโกหกฝั่ง Admin
//
// รูปแบบการตอบกลับ: [คงพฤติกรรมเดิมเพื่อแก้บั๊ก 524]
// ตอบ res.json() "ทันที" หลัง validate เสร็จ ก่อนเริ่มงานเขียนไฟล์จริง
// ลงดิสก์ (ซึ่งแม้จะเร็วกว่าอัปโหลดขึ้น Google Drive มาก แต่ยังคงเป็น
// disk I/O ที่ไม่ควรบล็อก event loop โดยไม่จำเป็น) — ไม่ await งาน
// เขียนไฟล์นั้นตรงนี้เด็ดขาด เพื่อไม่ให้ Admin ต้องรอ/เสี่ยงโดน
// Cloudflare gateway timeout ระหว่างที่ QR code บนจอ Customer ต้องยัง
// คงสแกนได้ตลอดเวลา ผลการบันทึกจริงถูก log ไว้ใน console แทน
app.post('/api/backup-to-drive', (req, res) => {
  const sessionId = req.body && req.body.sessionId;
  const entry = sessionStore.get(sessionId);

  if (!entry) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  const videoAvailable = !!entry.video;

  console.log(
    `[backup] queued local backup for session ${sessionId} ` +
    `(strip + ${entry.photos.length} photos${videoAvailable ? ' + video' : ', no video available'})`
  );

  // Fire-and-forget: ไม่ await ตรงนี้โดยตั้งใจ — ดูคำอธิบายด้านบน
  // การ "ไม่ await" นี้เองที่ทำให้ event loop ไม่ถูกบล็อก: ทันทีที่
  // res.json() ด้านล่างส่งออกไป Node.js ก็ว่างพอที่จะไปให้บริการ
  // request อื่นๆ ต่อ (รวมถึง socket.io events ที่คอยอัปเดตจอ
  // Customer) ได้ทันที ไม่ต้องรอให้เขียนไฟล์ลงดิสก์เสร็จก่อน
  backupSessionAssetsToLocalDisk(sessionId, entry).catch((err) => {
    console.error(`[backup] Local disk backup failed for session ${sessionId}:`, err.message);
  });

  res.json({
    ok: true,
    queued: true,
    sessionId,
    assetsQueued: { strip: true, photos: entry.photos.length, video: videoAvailable },
    videoIncluded: videoAvailable // ตามจริงเสมอ — เช็กจาก entry.video ตรงๆ ห้ามฮาร์ดโค้ด
  });
});

// [ตั้งค่าที่จัดเก็บไฟล์บนเครื่อง] ==================================
// LOCAL STORAGE — บันทึกไฟล์ลงโฟลเดอร์บนดิสก์แทน Google Drive
// ==================================================================
// PHOTOBOOTH_BACKUP_ROOT: โฟลเดอร์หลักที่เก็บ backup ทั้งหมด ตั้งอยู่
// ที่ Root ของโปรเจกต์ (ข้างๆ server.js) ชื่อ `photobooth_backups`
// ตามที่กำหนด — ปรับ path ได้ผ่าน environment variable ถ้าต้องการ
// เก็บไว้ไดรฟ์อื่นหรือโฟลเดอร์อื่น (เช่น external SSD)
const PHOTOBOOTH_BACKUP_ROOT =
  process.env.PHOTOBOOTH_BACKUP_ROOT || path.join(__dirname, 'photobooth_backups');

// Helper: ตั้งชื่อ sub-folder รายเซสชันจากเวลาปัจจุบัน ตามรูปแบบ
// ที่ต้องการ เช่น "SmaBU_Session_2026-08-25_1430" (คงชื่อรูปแบบเดิม
// จากตอนใช้ Google Drive ไว้ทุกประการ)
function buildSessionFolderName() {
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timePart = `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return `SmaBU_Session_${datePart}_${timePart}`;
}

// [ตั้งค่าที่จัดเก็บไฟล์บนเครื่อง] ==================================
// FILE-WRITE LOOP — จุดที่ไฟล์แต่ละไฟล์ของเซสชันถูกเขียนลงดิสก์จริง
// ==================================================================
// ฟังก์ชันนี้คือ core ของการบันทึกจริง: 1) สร้างโฟลเดอร์หลัก
// `photobooth_backups` ถ้ายังไม่มี (recursive: true กัน error ถ้ามี
// อยู่แล้ว) 2) สร้าง sub-folder ใหม่เฉพาะของเซสชันนี้ 3) วนลูปเขียน
// ไฟล์ทีละไฟล์ลงใน sub-folder นั้น (strip 1 ไฟล์ + รูปเดี่ยว 3 ไฟล์ +
// วิดีโอถ้ามี) — ใช้ fs/promises ทั้งหมด ไม่มีการเรียก sync variant
// เลยแม้แต่จุดเดียว เพื่อไม่ให้บล็อก event loop ระหว่างเขียนไฟล์ขนาด
// ใหญ่อย่างวิดีโอ
async function backupSessionAssetsToLocalDisk(sessionId, entry) {
  // ---- ขั้นที่ 1: เตรียมโฟลเดอร์หลัก + สร้างโฟลเดอร์ย่อยของเซสชันนี้ ----
  const folderName = buildSessionFolderName();
  const sessionFolderPath = path.join(PHOTOBOOTH_BACKUP_ROOT, folderName);
  await fsp.mkdir(sessionFolderPath, { recursive: true });

  console.log(`[backup] created local folder "${folderName}" (${sessionFolderPath}) for session ${sessionId}`);

  // ---- ขั้นที่ 2: รวมรายการไฟล์ทั้งหมดที่ต้องบันทึกของเซสชันนี้ ----
  // strip ใช้ชื่อ frame ที่ประกอบจาก frame.png ฝั่ง client แล้ว
  // (server ไม่ได้เก็บ frame.png ไว้แยก — มันถูกใช้ระหว่างขั้นตอน
  // ประกอบภาพที่ฝั่ง Admin browser เท่านั้น ผลลัพธ์สุดท้ายที่ได้คือ
  // entry.strip นี่เอง)
  const writeJobs = [
    {
      label: 'strip',
      fileName: `strip.${entry.strip.mimeType.split('/')[1] || 'jpg'}`,
      asset: entry.strip
    },
    ...entry.photos.map((photo, i) => ({
      label: `photo-${i + 1}`,
      fileName: `photo-${i + 1}.${photo.mimeType.split('/')[1] || 'jpg'}`,
      asset: photo
    }))
  ];

  if (entry.video) {
    writeJobs.push({
      label: 'video',
      fileName: `video.${entry.video.mimeType.split('/')[1] || 'mp4'}`,
      asset: entry.video
    });
  }

  // ---- ขั้นที่ 3: วนลูปเขียนไฟล์ทีละไฟล์ (sequential file-write loop) ----
  // เขียนทีละไฟล์ (await ทีละรอบ) แทนที่จะยิงพร้อมกันทั้งหมดด้วย
  // Promise.all เพื่อไม่ให้ดิสก์ I/O หลายตัวแย่งกันเขียนพร้อมกันจน
  // เพิ่ม latency รวมโดยไม่จำเป็น (โดยเฉพาะไฟล์วิดีโอที่ตัวใหญ่สุด)
  for (const job of writeJobs) {
    const filePath = path.join(sessionFolderPath, job.fileName);
    await fsp.writeFile(filePath, job.asset.buffer);
    console.log(`[backup]   -> saved ${job.label} (${job.fileName}) for session ${sessionId}`);
  }

  console.log(`[backup] Local disk backup complete for session ${sessionId} -> ${sessionFolderPath}`);
}




// GET /api/fetch-session-assets?id=<sessionId>
// ใครเรียกมัน: download.html ทันทีหลังอ่านค่า `?session=` จาก URL
//           ของตัวเองผ่าน URLSearchParams
// RESPONSE:  { stripUrl, photoUrls: [url0, url1, url2] } — JSON
//           object เล็กๆ ของ URL รูปภาพแบบ same-origin ที่หน้าเพจ
//           สามารถใส่ลงใน <img src> / <a href download> ได้โดยตรง
//           404 JSON เมื่อ id ไม่รู้จัก/หมดอายุ
app.get('/api/fetch-session-assets', (req, res) => {
  const entry = sessionStore.get(req.query.id);

  if (!entry) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  const id = req.query.id;
  res.json({
    stripUrl: `/api/session-image/${id}/strip`,
    photoUrls: [
      `/api/session-image/${id}/0`,
      `/api/session-image/${id}/1`,
      `/api/session-image/${id}/2`
    ]
  });
});

// GET /api/session-image/:id/:which
// ใครเรียกมัน: tag <img> และปุ่มดาวน์โหลดบน download.html (URL ที่
//           /api/fetch-session-assets คืนกลับมาชี้มาที่นี่) :which
//           คือ "strip" หรือ index ของรูป "0" | "1" | "2"
// RESPONSE:  ไบต์ของรูปภาพดิบพร้อม Content-Type ที่ถูกต้อง เพื่อให้
//           เบราว์เซอร์แสดงผลได้ทันที AND เพื่อให้ <a download>
//           บันทึกไบต์รูปภาพจริงแทนที่จะนำทางไปยัง JSON
app.get('/api/session-image/:id/:which', (req, res) => {
  const entry = sessionStore.get(req.params.id);
  if (!entry) return res.status(404).send('Not found or expired');

  const { which } = req.params;
  const asset = which === 'strip' ? entry.strip : entry.photos[Number(which)];

  if (!asset) return res.status(404).send('Not found');

  // [แก้ไข] สร้างนามสกุลไฟล์จาก mimeType จริง (asset.mimeType) แทน
  // การ hardcode '.png' — เพราะตอนนี้ภาพที่ส่งมาจาก client เป็น
  // JPEG แล้ว (ดูการแก้ไขใน public/script.js) ไม่ทำแบบนี้ไฟล์ที่
  // ดาวน์โหลดจะมีนามสกุลผิดประเภทไป
  const ext = asset.mimeType.split('/')[1] || 'jpg';
  res.set('Content-Type', asset.mimeType);
  res.set('Content-Disposition', 'inline; filename="photobooth-' + which + '.' + ext + '"');
  res.send(asset.buffer);
});

// --------------------------------------------------------------------
// 24-HOUR AUTO-DELETION PIPELINE (24-Hour Auto-Deletion Pipeline)
// --------------------------------------------------------------------
// [ปรับปรุง] ของเดิมกวาดล้าง sessionStore เป็นระยะเงียบๆ อยู่แล้ว
// (ทุก 15 นาที) — ยังคงกลไกเดิมไว้ทั้งหมด (in-memory Map +
// SESSION_TTL_MS 86,400,000ms = 24 ชม. ตรงตามที่โจทย์ระบุเป๊ะๆ)
// แค่เพิ่ม console.log ต่อรายการที่ถูกลบจริง เพื่อให้เห็นชัดเจนตอน
// รันหน้างานว่าระบบกำลังคืนพื้นที่หน่วยความจำให้จริง (มีประโยชน์มาก
// เวลาต้องพิสูจน์ว่าไม่มีข้อมูลลูกค้าเก่าตกค้างอยู่)
setInterval(() => {
  const now = Date.now();
  let purgedCount = 0;

  for (const [id, entry] of sessionStore.entries()) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      sessionStore.delete(id);
      purgedCount++;
      console.log(`[cleanup] purged expired session ${id} (age: ${Math.round((now - entry.createdAt) / 60000)} min)`);
    }
  }

  if (purgedCount > 0) {
    console.log(`[cleanup] done — purged ${purgedCount} session(s), ${sessionStore.size} still active`);
  }
}, 15 * 60 * 1000);

// --------------------------------------------------------------------
// [แก้ไขเพื่อแก้บั๊ก 524] GLOBAL ERROR-HANDLING MIDDLEWARE
// --------------------------------------------------------------------
// ตรวจโค้ดเดิมของ POST /api/strip แล้ว: ตัว handler เองเป็น
// synchronous ล้วนๆ (decodeDataUrl ใช้ Buffer.from แบบ sync,
// sessionStore.set แบบ sync) และทุก branch จบด้วย res.json()/
// res.status().json() อยู่แล้ว — จึง "ไม่ได้" มี unresolved
// callback/promise หรือ infinite loop ค้างอยู่ในไฟล์นี้ตามที่สงสัย
//
// สาเหตุที่เป็นไปได้จริงของ 524 (Gateway Timeout) กับ Cloudflare
// Quick Tunnel คือ: ก) ตัว POST body มีขนาดใหญ่มาก เพราะ
// hiddenCanvas.toDataURL('image/png') บันทึกภาพความละเอียดเต็ม
// แบบ PNG ไม่บีบอัด (ดูการแก้ไขใน public/script.js คู่กันที่เปลี่ยน
// เป็น JPEG คุณภาพสูงแทน — ลดขนาด payload ลงได้มากถึง 5-10 เท่า)
// รวมกับ ข) ถ้า body ใหญ่เกิน limit ที่ express.json({limit:'10mb'})
// กำหนดไว้ Express เวอร์ชันเก่าบางเวอร์ชัน/การตั้งค่าบางแบบจะไม่ส่ง
// response กลับเลยถ้าไม่มี error-handling middleware ท้ายสุดคอย
// ดักไว้ — ทำให้ฝั่ง Cloudflare รอจน timeout ที่ 100 วินาทีแล้วคืน
// 524 ให้ผู้ใช้แทนที่จะเป็น error message ที่ชัดเจน
//
// Middleware นี้ (4 พารามิเตอร์ = Express error handler แบบพิเศษ)
// รับประกันว่า "ทุก" error ที่เกิดขึ้นในระหว่างการประมวลผล request
// ใดๆ ก็ตาม (รวมถึง payload-too-large จาก express.json) จะได้รับ
// การตอบกลับเป็น JSON เสมอ ไม่มีทางค้างจนเกิด Gateway Timeout จาก
// สาเหตุนี้อีก
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}: ${err.message}`);

  res.status(status).json({
    error: status === 413
      ? 'Upload too large — try again (photos are now sent as compressed JPEGs).'
      : 'Server error while processing the request.'
  });
});

// --------------------------------------------------------------------
// SOCKET.IO: REAL-TIME EVENT RELAY
// --------------------------------------------------------------------
// This is the heart of the "dual-screen" architecture. Every browser
// tab that loads our page (whether ?role=admin or ?role=customer)
// opens its own Socket.io connection to this server. Below, we
// define what happens when each of those connections sends us data.
//
// ROOM CONCEPT:
// Socket.io lets you group connected sockets into named "rooms" and
// broadcast messages to just that group. We put every connected
// client into ONE shared room (SESSION_ROOM) so that, with exactly
// one Admin tab and one Customer tab open, any event one of them
// emits is automatically relayed to the other — without either side
// needing to know the other's specific socket ID.
//
// (For a production system running MANY photobooths at once, you'd
// instead generate a unique room/session ID per booth — e.g. from a
// URL parameter like ?session=booth-42 — so booth A's photos never
// leak into booth B's customer display. That's flagged below as a
// natural extension point.)
const SESSION_ROOM = 'photobooth-session';

// [แก้ไข] LIVE-SESSION STATE SNAPSHOT (root cause ของ "รูปหาย")
// --------------------------------------------------------------
// เดิม server ทำหน้าที่แค่ "relay" เหตุการณ์สดๆ เท่านั้น — ไม่เคย
// เก็บสถานะปัจจุบันไว้เลย ปัญหาคือถ้า Customer window ถูกเปิดขึ้น
// (หรือรีเฟรช/หลุดการเชื่อมต่อแล้วต่อใหม่ ซึ่งเกิดง่ายมากผ่าน
// Cloudflare Tunnel) *หลังจาก* Admin ถ่ายรูปไปแล้วบางส่วนหรือกด
// Export ไปแล้ว รูปที่ถ่ายไปก่อนหน้านั้นจะไม่ถูกส่งซ้ำให้เลย เพราะ
// socket.to(ROOM).emit(...) ส่งให้เฉพาะคนที่ "อยู่ในห้องอยู่แล้ว ณ
// วินาทีนั้น" เท่านั้น — Customer ที่เพิ่งต่อเข้ามาใหม่จะไม่เห็นภาพ
// ที่ถ่ายไปแล้วเลย นี่คือสาเหตุจริงของบั๊ก "Captured Photos Missing"
// (ไม่ใช่ race condition ของ DOM ข้ามหน้าต่าง — โค้ดนี้ไม่มีการยัด
// DOM ข้ามหน้าต่างสำหรับรูป/QR เลยแม้แต่จุดเดียว ทุกอย่างวิ่งผ่าน
// socket.io ทั้งหมดอยู่แล้ว และ id ต่างๆ ก็ match กันถูกต้องระหว่าง
// script.js กับ index.html)
//
// แก้โดยให้ server เก็บ "สถานะล่าสุด" ของเซสชันปัจจุบันไว้ในตัวแปร
// ธรรมดา (ไม่ต้องซับซ้อนถึงขั้น database เพราะมีแค่ 1 บูธ/1 ห้อง)
// แล้ว replay สถานะนั้นให้ socket ที่เพิ่งต่อเข้ามาใหม่ทุกครั้ง
let latestSlots = [null, null, null]; // sync กับ slots[] ฝั่ง Admin
let latestCheckout = null;            // { stripDataUrl, downloadUrl } | null ถ้ายังไม่มี checkout ที่เปิดอยู่

// io.on('connection', ...) fires once for EVERY new socket that
// connects — i.e. once per browser tab that loads our page (as long
// as JS runs and calls io()). The `socket` parameter is that
// specific browser tab's private communication channel.
io.on('connection', (socket) => {
  // Put this newly connected socket into our shared room so it can
  // receive (and send) room-broadcast events.
  socket.join(SESSION_ROOM);

  console.log(`[socket] connected: ${socket.id} (${io.engine.clientsCount} total)`);

  // Tell everyone ELSE already in the room that a new peer arrived.
  // `socket.to(ROOM)` broadcasts to everyone in that room EXCEPT the
  // sender — so if the Customer display connects, only the Admin
  // (who was already there) hears about it, not itself.
  // The Admin UI uses this to light up a "Customer Display: linked"
  // status indicator.
  socket.to(SESSION_ROOM).emit('peer-joined', { socketId: socket.id });

  // [แก้ไข] REPLAY ล่าสุดให้ socket ที่เพิ่งต่อเข้ามา (ทั้ง Customer
  // ที่เปิดช้า และ Customer ที่หลุด-ต่อใหม่) — ทำให้จอไม่ว่างเปล่า
  // อีกต่อไปแม้จะพลาดเหตุการณ์สดๆ ที่เกิดไปก่อนหน้านี้ Client ฝั่ง
  // customer (script.js) เป็นคนตัดสินใจว่าจะใช้ payload นี้ยังไง —
  // ฝั่ง admin เพิกเฉย event นี้ได้เลยเพราะไม่ได้ listen มันอยู่แล้ว
  socket.emit('sync-state', {
    slots: latestSlots,
    checkout: latestCheckout
  });

  // ------------------------------------------------------------
  // [ลบ] EVENT: "sync-camera-state" — ถูกลบออกทั้งหมด
  // ------------------------------------------------------------
  // เดิมตรงนี้คือ socket.on('sync-camera-state', payload => { ... })
  // ที่คอย relay เฟรม JPEG ที่ Admin บีบอัดจาก <canvas> ไปให้
  // Customer แสดงผลเป็น <img> — เป็นต้นเหตุของ latency ที่โจทย์
  // ต้องการให้กำจัดทิ้ง
  //
  // ตอนนี้ภาพวิดีโอสดไม่ผ่าน server อีกต่อไปเลย: ฝั่ง Admin
  // (script.js) จับ MediaStream ตัวจริงจาก getUserMedia() แล้วเขียน
  // ใส่ .srcObject ของ <video id="customer-webcam"> ในหน้าต่าง
  // Customer โดยตรงผ่าน window reference ข้ามหน้าต่าง (same-origin)
  // — ดูฟังก์ชัน pushStreamToCustomerWindow() ใน public/script.js
  //
  // เพราะฝั่ง client ไม่ emit event นี้อีกแล้ว การเก็บ handler นี้ไว้
  // ที่ server จะเป็นแค่โค้ดที่ตายแล้ว (dead code) ไม่มีวันถูกเรียก
  // จึงลบทิ้งไปตรงๆ เพื่อความสะอาดของโค้ด

  // ------------------------------------------------------------
  // EVENT: "admin-captured-photo"
  // ------------------------------------------------------------
  // WHO SENDS IT: the Admin controller, exactly once per click of
  //           the "Capture Photo" button.
  // PAYLOAD:  { index: 0 | 1 | 2, dataUrl: "data:image/png;base64,..." }
  //           `index` tells the Customer display WHICH of the 3
  //           Polaroid slots this photo belongs in (0-based; the
  //           Admin cycles 0 → 1 → 2 → back to 0 to allow retakes).
  // WHO RECEIVES IT: the Customer display, which injects the image
  //           into the matching slot and triggers a small "pop in"
  //           CSS animation so the reveal feels alive.
  //
  // We do a minimal shape check before relaying — this is basic
  // defensive programming so a malformed or malicious payload from a
  // misbehaving client doesn't get blindly forwarded to the other
  // screen.
  socket.on('admin-captured-photo', (payload) => {
    const isValid =
      payload &&
      typeof payload.index === 'number' &&
      typeof payload.dataUrl === 'string';

    if (!isValid) return; // silently ignore malformed payloads

    // [แก้ไข] อัปเดต snapshot ฝั่ง server ด้วย ไม่ใช่แค่ relay ต่อ —
    // นี่คือสิ่งที่ทำให้ Customer ที่ต่อเข้ามาทีหลังเห็นรูปที่ถ่าย
    // ไปแล้วก่อนหน้านี้ (ดู socket.emit('sync-state', ...) ด้านบน)
    latestSlots[payload.index] = payload.dataUrl;

    console.log(`[socket] photo captured -> slot ${payload.index + 1}`);
    socket.to(SESSION_ROOM).emit('admin-captured-photo', payload);
  });

  // ------------------------------------------------------------
  // EVENT: "export-complete"
  // ------------------------------------------------------------
  // WHO SENDS IT: the Admin controller, after all 3 photos have
  //           been stitched together client-side into the final
  //           pastel photo strip (see script.js buildStripAndDownload).
  // PAYLOAD:  { dataUrl: "data:image/png;base64,..." } — the finished
  //           strip image.
  // WHO RECEIVES IT: the Customer display, which shows a celebratory
  //           full-screen overlay with the finished strip and a
  //           "Thank you!" message for a few seconds — a nice closing
  //           beat for the guest.
  socket.on('export-complete', (payload) => {
    socket.to(SESSION_ROOM).emit('export-complete', payload);
  });

// ------------------------------------------------------------
  // EVENT: "broadcast-session-checkout"
  // ------------------------------------------------------------
  // WHO SENDS IT: the Admin controller, right after the strip upload
  //           to POST /api/strip succeeds and the server has handed
  //           back the unique download URL.
  // PAYLOAD:  { stripDataUrl: "data:image/png;base64,...",
  //             downloadUrl: "https://.../download.html?session=..." }
  // WHO RECEIVES IT: the Customer Display's checkout modal — this is
  //           what makes both screens pop open the exact same layout
  //           at the exact same moment.
  socket.on('broadcast-session-checkout', (payload) => {
    const isValid =
      payload &&
      typeof payload.stripDataUrl === 'string' &&
      typeof payload.downloadUrl === 'string';

    if (!isValid) return; // silently ignore malformed payloads

    // [แก้ไข] เก็บ checkout ล่าสุดไว้ด้วย เผื่อ Customer window
    // หลุด-ต่อใหม่ระหว่างที่ QR/checkout modal เปิดค้างอยู่พอดี
    latestCheckout = payload;

    socket.to(SESSION_ROOM).emit('broadcast-session-checkout', payload);
  });

  // ------------------------------------------------------------
  // EVENT: "admin-dismiss-checkout"
  // ------------------------------------------------------------
  // WHO SENDS IT: the Admin controller ONLY — clicking either the
  //           "✕" icon or "Start New Session" button. The Customer's
  //           copy of the modal has no close controls at all, so it
  //           can never send this event itself.
  // PAYLOAD:  none needed.
  // WHO RECEIVES IT: the Customer Display, closing its checkout
  //           modal at the exact same moment the Admin's closes.
  socket.on('admin-dismiss-checkout', () => {
    latestCheckout = null; // [แก้ไข] เคลียร์ snapshot พร้อมกับปิด modal จริง
    socket.to(SESSION_ROOM).emit('admin-dismiss-checkout');
  });

  // ------------------------------------------------------------
  // EVENT: "session-reset"
  // ------------------------------------------------------------
  // WHO SENDS IT: the Admin controller, when the operator clicks
  //           "Reset Session" to clear all 3 slots and prep for the
  //           next guest.
  // PAYLOAD:  none needed — it's a simple instruction, not data.
  // WHO RECEIVES IT: the Customer display, which empties its 3
  //           Polaroid slots back to their placeholder state.
  socket.on('session-reset', () => {
    // [แก้ไข] เคลียร์ snapshot ฝั่ง server ให้ตรงกับฝั่ง Admin ทุกครั้ง
    // ที่มีการ reset — ไม่งั้น Customer ที่ต่อเข้ามาใหม่หลัง reset
    // จะยังเห็นรูปเซสชันก่อนหน้าอยู่
    latestSlots = [null, null, null];
    latestCheckout = null;
    socket.to(SESSION_ROOM).emit('session-reset');
  });

  // ------------------------------------------------------------
  // BUILT-IN EVENT: "disconnect"
  // ------------------------------------------------------------
  // Fires automatically whenever this socket's connection drops —
  // tab closed, page navigated away, network dropped, etc. We log it
  // for visibility and let the OTHER peer in the room know, so e.g.
  // the Admin's "Customer Display: linked" indicator can turn back
  // off if that window is closed.
  socket.on('disconnect', (reason) => {
    console.log(`[socket] disconnected: ${socket.id} (${reason})`);
    socket.to(SESSION_ROOM).emit('peer-left', { socketId: socket.id });
  });
});

// --------------------------------------------------------------------
// START LISTENING
// --------------------------------------------------------------------
// Note we call .listen() on the raw `server` (http.Server), NOT on
// `app` — this is what lets both Express (HTTP) and Socket.io
// (WebSocket) share the exact same port.
server.listen(PORT, () => {
  console.log(`Photobooth server running on http://localhost:${PORT}`);
  console.log(`  Admin view:    http://localhost:${PORT}/index.html?role=admin`);
  console.log(`  Customer view: http://localhost:${PORT}/index.html?role=customer`);

  // [เปลี่ยนระบบจัดเก็บ] แจ้งตำแหน่งโฟลเดอร์หลักที่จะใช้เก็บไฟล์
  // backup ทั้งหมด ให้เห็นชัดเจนตั้งแต่ตอนเปิด server (สร้างอัตโนมัติ
  // ตอนกด backup ครั้งแรก ถ้ายังไม่มีโฟลเดอร์นี้อยู่)
  console.log(`  [info] ไฟล์ backup จะถูกบันทึกไว้ที่: ${PHOTOBOOTH_BACKUP_ROOT}`);

  // [ใหม่] แจ้งเตือนให้ชัดเจนว่านี่คือโหมด local-only ถ้าไม่มี
  // PUBLIC_BASE_URL (คือรันด้วย "node server.js" ตรงๆ ไม่ผ่าน
  // start.js) — ลิงก์ QR ที่สร้างจะใช้ req.protocol/req.get('host')
  // แทน ซึ่งใช้ได้เฉพาะในวง LAN เดียวกัน ไม่ใช่อินเทอร์เน็ตสาธารณะ
  if (!process.env.PUBLIC_BASE_URL) {
    console.log('  [info] PUBLIC_BASE_URL is not set — QR links will use the local');
    console.log('         request host. Run "npm run start:tunnel" instead of');
    console.log('         "npm start" to expose this server publicly via Cloudflare.');
  } else {
    console.log(`  Public URL (via Cloudflare Tunnel): ${process.env.PUBLIC_BASE_URL}`);
  }
});
