/**
 * ====================================================================
 * script.js
 * ====================================================================
 * All client-side behavior for the Dual-Screen Photobooth System.
 * This single file runs on EVERY page load, for BOTH roles — it
 * decides which role it's playing based on the URL, then delegates
 * to one of two large functions: runAdmin() or runCustomer().
 *
 * ====================================================================
 * [REFACTOR NOTE - อ่านก่อน] HYBRID LOCAL-GLOBAL / ZERO-LATENCY BUILD
 * ====================================================================
 * ไฟล์นี้ถูกปรับสถาปัตยกรรมใหม่ให้รองรับโหมด "จอคู่บนเครื่องเดียว
 * (dual-monitor extend mode)" โดยจุดเปลี่ยนที่สำคัญที่สุดคือ:
 *
 *   เดิม: Admin จับภาพจากกล้องเป็นเฟรม JPEG เล็กๆ ~8 ครั้ง/วินาที
 *         แล้วส่งผ่าน Socket.io ไปให้ Customer วาดลง <img> — มี
 *         การหน่วงเวลา (compress/encode/network/decode) เสมอ
 *
 *   ใหม่: Admin เปิดกล้องครั้งเดียวได้ MediaStream object ตัวเดียว
 *         แล้ว "แชร์ตัวเดียวกัน" นั้นเข้าไปใน <video> ของหน้าต่าง
 *         Customer โดยตรง (ผ่าน window reference ที่ได้จาก
 *         window.open — ใช้ได้เพราะเป็นเครื่อง/origin เดียวกัน)
 *         ผลคือภาพทั้ง 2 จอ "เหมือนกันแบบ 0ms" ไม่มีการบีบอัด/ส่ง
 *         ผ่าน server เลย ดูฟังก์ชัน pushStreamToCustomerWindow()
 *         ในส่วน runAdmin() ด้านล่าง
 *
 * Socket.io ยังคงถูกใช้งานอยู่ แต่ถูกจำกัดให้เป็นแค่ "สัญญาณเบาๆ"
 * เท่านั้น: countdown-tick (นับถอยหลัง), admin-captured-photo
 * (อัปเดตช่องรูปที่ถ่ายแล้ว), export-complete / checkout modal /
 * session-reset — ไม่มีข้อมูลวิดีโอสตรีมสดวิ่งผ่าน socket อีกต่อไป
 * ====================================================================
 *
 * HIGH-LEVEL DATA FLOW (read this before diving into the code):
 *
 *   ADMIN BROWSER TAB                         CUSTOMER BROWSER TAB
 *   ------------------                        ---------------------
 *   getUserMedia() -> <video id="admin-webcam">
 *        |
 *        | ONE-TIME direct DOM handoff (no socket, no server):
 *        | customerWindow.document
 *        |   .getElementById('customer-webcam').srcObject = mediaStream
 *        +---------------------------------------------->  <video id="customer-webcam">
 *                                                             renders the SAME live
 *                                                             hardware stream, 0ms delay
 *
 *   [user clicks "Capture Photo"]
 *        |
 *        v
 *   draw full-res mirrored frame -> hidden <canvas>
 *        |
 *        | socket.emit('admin-captured-photo', {index, dataUrl})
 *        +----------------- via server ------------------>  socket.on('admin-captured-photo')
 *                                                             -> inject <img> into Polaroid slot
 *                                                                + play "pop" animation
 *
 *   [user clicks "Export to Frame"]
 *        |
 *        v
 *   stitch 3 photos + text -> big <canvas> -> auto-download PNG
 *        |
 *        | socket.emit('export-complete', {dataUrl})
 *        +----------------- via server ------------------>  socket.on('export-complete')
 *                                                             -> show "Thank you" overlay
 * ==================================================================== */

(function () {
  // ------------------------------------------------------------------
  // STEP 1: DETECT WHICH ROLE THIS PAGE LOAD SHOULD PLAY
  // ------------------------------------------------------------------
  // URLSearchParams parses the query string portion of the current
  // URL (everything after "?"). For a URL like
  // "http://localhost:3000/index.html?role=admin", `params.get('role')`
  // returns the string "admin".
  const params = new URLSearchParams(window.location.search);
  const role = params.get('role'); // 'admin' | 'customer' | null

  // Toggle the "hidden" CSS class (display:none) on each of the three
  // top-level view containers defined in index.html, so exactly ONE
  // is visible depending on the detected role.
  document.getElementById('adminView').classList.toggle('hidden', role !== 'admin');
  document.getElementById('customerView').classList.toggle('hidden', role !== 'customer');
  document.getElementById('noRoleView').classList.toggle('hidden', role === 'admin' || role === 'customer');

  // Update the browser tab title too, purely for clarity when the
  // Admin has multiple tabs/windows open at once.
  if (role === 'admin') {
    document.title = 'Photobooth — Admin Dashboard';
    runAdmin();
  } else if (role === 'customer') {
    document.title = 'Photobooth — Customer View';
    runCustomer();
  } else {
    document.title = 'Photobooth System';
    // No role specified: the #noRoleView picker (plain HTML links)
    // handles navigation from here — no further JS needed.
  }

  /* ==================================================================
     ADMIN ROLE
     ==================================================================
     Everything the "backstage" controller needs: webcam access,
     capture logic, slot bookkeeping, and the final strip export. */
  function runAdmin() {
    // ----------------------------------------------------------------
    // SOCKET.IO CONNECTION
    // ----------------------------------------------------------------
    // io() (provided globally by the socket.io.js client script tag
    // in index.html) opens a connection back to whatever server this
    // page was loaded from — no URL/config needed since it defaults
    // to "same origin".
    const socket = io();

    // ----------------------------------------------------------------
    // DOM REFERENCES
    // ----------------------------------------------------------------
    // Grabbing every element we'll need up front, once, instead of
    // re-querying the DOM repeatedly inside event handlers.
    // [เปลี่ยน] id เดิมคือ "video" — เปลี่ยนเป็น "admin-webcam" ให้
    // ตรงกับ index.html เวอร์ชันใหม่ (ดูคอมเมนต์ที่ index.html)
    const video = document.getElementById('admin-webcam');
    const camPlaceholder = document.getElementById('camPlaceholder');
    const flash = document.getElementById('flash');
    const openCameraBtn = document.getElementById('openCameraBtn');
    const captureBtn = document.getElementById('captureBtn');
    const exportBtn = document.getElementById('exportBtn');
    const resetBtn = document.getElementById('resetBtn');
    const launchCustomerBtn = document.getElementById('launchCustomerBtn');
    const cloudBackupBtn = document.getElementById('cloudBackupBtn');
    const cloudBackupStatus = document.getElementById('cloudBackupStatus');
    const adminStatus = document.getElementById('adminStatus');
    const camDot = document.getElementById('camDot');
    const linkDot = document.getElementById('linkDot');
    const hiddenCanvas = document.getElementById('hiddenCanvas');
    const stripCanvas = document.getElementById('stripCanvas');
    const checkoutModal = document.getElementById('checkoutModal');
    const checkoutStripImg = document.getElementById('checkoutStripImg');
    const checkoutQrImg = document.getElementById('checkoutQrImg');
    const checkoutQrHint = document.getElementById('checkoutQrHint');
    const checkoutCloseX = document.getElementById('checkoutCloseX');
    const checkoutStartNewBtn = document.getElementById('checkoutStartNewBtn');

    // ----------------------------------------------------------------
    // APPLICATION STATE
    // ----------------------------------------------------------------
    // `slots` holds up to 3 captured photos as PNG data URLs. Starts
    // as [null, null, null] meaning "nothing captured yet". This is
    // the SINGLE SOURCE OF TRUTH the Admin side uses to know what has
    // been shot and whether exporting is currently possible.
    const slots = [null, null, null];

    // `nextIndex` is the SEQUENTIAL SLOT POINTER: which slot the NEXT
    // click of "Capture Photo" will fill. It starts at 0 (slot #1 in
    // human-facing 1-based terms) and after each capture is advanced
    // with `(nextIndex + 1) % 3`, which wraps 0 -> 1 -> 2 -> 0 -> ...
    // This modulo-wraparound is exactly what gives us "overwrite
    // capability": once all 3 slots are full, the 4th click doesn't
    // error out or get blocked — it simply loops back and overwrites
    // slot 0, letting the guest freely retake any photo.
    let nextIndex = 0;

    // Tracks whether getUserMedia() has succeeded, so we can guard
    // the capture/broadcast logic against running before a stream
    // actually exists.
    let streamActive = false;

    // [ใหม่] เก็บ session id ของเซสชันที่ export ล่าสุด — ใช้เป็น
    // "อ้างอิง" ว่าปุ่ม backup กำลังพูดถึงเซสชันไหน server.js คืน
    // ค่านี้กลับมาให้ตรงๆ ใน response ของ POST /api/strip อยู่แล้ว
    // (res.json({ id, url })) จึงไม่ต้องแกะจาก url เอง
    let currentSessionId = null;

    // [ใหม่] เก็บ MediaStream object ตัวจริงจากกล้อง (ไม่ใช่แค่
    // boolean เหมือน streamActive) เพราะตอนนี้เราต้องส่ง "ตัวอ้างอิง
    // เดียวกัน" นี้ไปแปะที่ <video> ของหน้าต่าง Customer ด้วย — ถ้า
    // Customer เปิดหน้าต่างขึ้นมาทีหลัง (กล้องเปิดอยู่ก่อนแล้ว) เรา
    // จะได้มีตัวแปรนี้ไว้ใช้ push ซ้ำได้ทันทีโดยไม่ต้องขอกล้องใหม่
    let mediaStream = null;

    // [ใหม่] เก็บ reference ของหน้าต่าง Customer ที่เปิดผ่าน
    // window.open() (ดู launchCustomerBtn ด้านล่าง) ไว้ในสโคปนี้
    // เพื่อให้ openCameraBtn (ซึ่งอาจถูกกดหลัง Launch) เข้าถึง DOM
    // ของหน้าต่างนั้นได้โดยตรงเช่นกัน
    let customerWindow = null;

    // ----------------------------------------------------------------
    // SOCKET EVENT LISTENERS: CONNECTION / PEER STATUS
    // ----------------------------------------------------------------
    // Fires once, right after this browser tab establishes its
    // Socket.io connection to the server.
    socket.on('connect', () => {
      adminStatus.textContent = 'Connected to server. Open the camera to begin.';
    });

    // The server relays this whenever ANOTHER socket (i.e. the
    // Customer Display) joins the same shared room — see server.js.
    // We use it purely to flip the "Customer Display" status dot on.
    socket.on('peer-joined', () => {
      linkDot.classList.add('linked');
      adminStatus.textContent = 'Customer display connected.';
    });

    // Mirror image of the above: turn the status dot back off if the
    // Customer Display disconnects (tab closed, network drop, etc).
    socket.on('peer-left', () => {
      linkDot.classList.remove('linked');
    });

    // ----------------------------------------------------------------
    // WEBCAM ACCESS INITIALIZATION
    // ----------------------------------------------------------------
    openCameraBtn.addEventListener('click', async () => {
      try {
        // navigator.mediaDevices.getUserMedia() is the standard Web
        // API for requesting camera/microphone access. It returns a
        // Promise that resolves to a MediaStream on success, or
        // rejects (caught below) if the user denies permission or no
        // camera is available. We request video only (audio:false)
        // since a photobooth has no use for sound, and
        // facingMode:'user' prefers the front-facing camera on
        // devices that have more than one (e.g. laptops/tablets).
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false
        });

        // [ใหม่] เก็บ stream ไว้ในตัวแปรระดับบนของ runAdmin() ด้วย
        // (ไม่ใช่แค่เซ็ตลง video.srcObject เฉยๆ เหมือนเดิม) เพราะ
        // เราจะต้องใช้ตัวแปรเดียวกันนี้ "อ้างอิงซ้ำ" ไปแปะใส่ <video>
        // ของหน้าต่าง Customer ด้านล่างด้วย
        mediaStream = stream;

        // Attach the live MediaStream to our <video> element. Setting
        // .srcObject (rather than .src) is the modern, correct way to
        // pipe a MediaStream into a <video> tag.
        video.srcObject = stream;

        // Swap the placeholder text for the actual video feed now
        // that there's something to show.
        video.style.display = 'block';
        camPlaceholder.style.display = 'none';

        // Flip our internal state flag and update the UI to reflect
        // "camera is live": light up the status dot, enable the
        // Capture button, disable/relabel the Open Camera button
        // (there's no need to open it twice), and update the status
        // message the Admin reads.
        streamActive = true;
        camDot.classList.add('live');
        captureBtn.disabled = false;
        openCameraBtn.disabled = true;
        openCameraBtn.textContent = 'Camera Live';
        adminStatus.textContent = 'Camera live. Click "Capture Photo" to fill slots.';

        // [ใหม่] แทนที่จะ emit 'sync-camera-state' ไปบอก Customer
        // ผ่าน server เหมือนเดิม ตอนนี้เรา "ยัด MediaStream ตัวจริง"
        // เข้าไปในหน้าต่าง Customer โดยตรงทันที (ถ้าหน้าต่างนั้นถูก
        // เปิดไว้ก่อนแล้ว) — ไม่มี server ไม่มี socket เกี่ยวข้องกับ
        // ภาพวิดีโอสดอีกต่อไป ถ้าหน้าต่าง Customer ยังไม่ถูกเปิด
        // ฟังก์ชันนี้จะคืนค่า false เฉยๆ และไม่ทำอะไร — เดี๋ยว
        // launchCustomerBtn (ด้านล่าง) จะ push ซ้ำให้เองตอนหน้าต่าง
        // เปิดขึ้นมาทีหลัง
        pushStreamToCustomerWindow();
      } catch (err) {
        // Common failure reasons: user clicked "Block" on the browser
        // permission prompt, no camera hardware present, or the page
        // isn't served over HTTPS/localhost (getUserMedia requires a
        // "secure context"). We surface the raw error message so
        // it's actionable for debugging.
        
        alert('Could not access camera: ' + err.message);
      }
    });

    // ----------------------------------------------------------------
    // [ใหม่ทั้งหมด] ZERO-LATENCY STREAM SHARING (แทนที่ระบบเดิม)
    // ----------------------------------------------------------------
    // เดิมฟังก์ชันนี้ชื่อ startLiveStreamBroadcast() — วาดเฟรมจาก
    // <video> ลง canvas เล็กๆ แล้วบีบอัดเป็น JPEG ส่งผ่าน socket
    // ~8 ครั้ง/วินาที (ดูคอมเมนต์ด้านบนสุดของไฟล์สำหรับเหตุผลที่
    // ตัดออก) ตอนนี้แทนที่ด้วย pushStreamToCustomerWindow() ซึ่ง
    // "ยัด object" ไม่ใช่ "ยัดภาพ" — ทำครั้งเดียวก็พอ ไม่ต้องมี
    // interval/timer ใดๆ อีกต่อไป เพราะ <video> element จะเล่น
    // MediaStream ที่ได้รับต่อไปเองโดยอัตโนมัติ (มันคือ live source
    // เดียวกับกล้องจริง)
    //
    // ฟังก์ชันนี้ถูกเรียกจาก 2 จุด (ลำดับไหนก่อนก็ได้ ผู้ใช้งานจริง
    // อาจเปิดกล้องก่อนหรือเปิดจอลูกค้าก่อนก็ได้ทั้งคู่):
    //   1. ทันทีหลัง getUserMedia() สำเร็จ (เผื่อหน้าต่าง Customer
    //      เปิดอยู่ก่อนแล้ว)
    //   2. จาก launchCustomerBtn ทุกครั้งที่เปิด/โฟกัสหน้าต่าง
    //      Customer (เผื่อกล้องเปิดอยู่ก่อนแล้ว แต่หน้าต่างเพิ่งเปิด)
    //
    // คืนค่า true = ยัดสำเร็จแล้ว, false = ยังทำไม่ได้ตอนนี้ (เช่น
    // หน้าต่างยังไม่เปิด หรือเปิดแล้วแต่ script.js ของมันยังโหลด/
    // สร้าง DOM ไม่เสร็จ) ผู้เรียกที่ต้องการความชัวร์ (launchCustomerBtn)
    // จะใช้ค่า return นี้ในการ retry เป็นช่วงๆ ดูด้านล่าง
    function pushStreamToCustomerWindow() {
      // ยังไม่มีอะไรให้แชร์ (กล้องยังไม่เปิด) หรือยังไม่มีหน้าต่าง
      // Customer เลย หรือหน้าต่างนั้นถูกปิดไปแล้ว -> ทำอะไรไม่ได้
      if (!mediaStream || !customerWindow || customerWindow.closed) {
        return false;
      }

      try {
        // customerWindow คือ reference ของ "หน้าต่างเบราว์เซอร์อีก
        // บาน" ที่ได้จาก window.open() — เพราะเปิดจาก origin/URL
        // เดียวกัน (same-origin) เราจึงมีสิทธิ์เข้าถึง
        // customerWindow.document ได้โดยตรงแบบซิงโครนัส ไม่ต้องผ่าน
        // postMessage หรือ server ใดๆ ทั้งสิ้น
        const custVideo = customerWindow.document.getElementById('customer-webcam');
        const custPlaceholder = customerWindow.document.getElementById('liveFeedPlaceholder');

        // หน้าต่างเปิดแล้วก็จริง แต่ script.js/DOM ของมันอาจยังโหลด
        // ไม่เสร็จ (element ยังไม่ถูกสร้าง) — ในเคสนี้ยังไม่ throw
        // error แค่ยังหา element ไม่เจอ ให้ถือว่า "ยังไม่พร้อม" แล้ว
        // return false เพื่อให้ผู้เรียกลองใหม่ภายหลัง
        if (!custVideo) return false;

        // นี่คือหัวใจของฟีเจอร์นี้ทั้งหมด: เอา MediaStream object
        // "ตัวเดียวกัน" กับที่ผูกกับ <video id="admin-webcam"> ของ
        // เรา ไปผูกกับ <video id="customer-webcam"> ของอีกหน้าต่าง
        // ด้วย — เบราว์เซอร์อนุญาตให้ MediaStream หนึ่งตัวเล่นพร้อม
        // กันได้ในหลาย <video> element โดยไม่ต้อง clone หรือ encode
        // ใหม่เลย ผลคือภาพทั้ง 2 จอ "ตรงกันแบบเรียลไทม์ 100%"
        custVideo.srcObject = mediaStream;

        // เบราว์เซอร์บางตัวไม่ auto-play <video> ที่เพิ่งได้รับ
        // srcObject ข้ามหน้าต่างแบบทันที (แม้จะมี attribute autoplay
        // อยู่แล้วก็ตาม) — เรียก .play() ซ้ำเองเพื่อความชัวร์ ใส่
        // .catch(()=>{}) ไว้เผื่อ browser คืน rejected promise (ซึ่ง
        // ไม่ใช่ปัญหาในเคสนี้เพราะ video มี muted อยู่แล้ว จึงมักจะ
        // เล่นได้เสมอ) แต่กันไว้ก่อนไม่ให้ error หลุดขึ้น console
        custVideo.play().catch(() => {});

        // ซ่อน placeholder "Waiting for Admin to start camera..."
        // เพราะตอนนี้มีภาพจริงมาแสดงแล้ว (ถ้ามันมีอยู่ในหน้านั้น)
        if (custPlaceholder) custPlaceholder.classList.add('hidden');
        custVideo.classList.remove('hidden');

        return true;
      } catch (err) {
        // จะเกิดขึ้นได้ในกรณีเดียวเป็นหลัก: customerWindow ถูกนำทาง
        // ออกไปยัง origin อื่น (cross-origin) ซึ่งไม่ควรเกิดในระบบนี้
        // เพราะเราเปิดจาก URL เดียวกันเสมอ — log ไว้เผื่อ debug แต่
        // ไม่ทำให้ระบบล่ม
        console.warn('[stream] could not attach stream to customer window:', err.message);
        return false;
      }
    }

    // [ใหม่] ตัวช่วย retry: เรียก pushStreamToCustomerWindow() ซ้ำ
    // เป็นช่วงๆ (ทุก 200ms) จนกว่าจะสำเร็จ หรือครบ ~5 วินาทีแล้วยอมแพ้
    // จำเป็นเพราะ window.open() คืนค่า reference ของหน้าต่างใหม่มา
    // "ทันที" แต่ตัวหน้า HTML/JS ข้างในนั้นยังโหลดไม่เสร็จในติ๊กเดียว
    // กัน — ต้องรอให้ DOM ของมันพร้อมก่อนถึงจะหา #customer-webcam เจอ
    function retryPushStreamToCustomerWindow() {
      let attempts = 0;
      const maxAttempts = 25; // 25 x 200ms = 5 วินาที
      const intervalId = setInterval(() => {
        attempts++;
        const success = pushStreamToCustomerWindow();
        if (success || attempts >= maxAttempts) {
          clearInterval(intervalId);
        }
      }, 200);
    }

    // ----------------------------------------------------------------
    // CONFIG: BURST SEQUENCE
    // ----------------------------------------------------------------
    const SHOT_COUNT = 3;        // total photos per burst — matches the 3 slots
    const COUNTDOWN_SECONDS = 5; // seconds counted down before EACH shot (customizable)

    // Tracks whether a burst is currently running, so the button
    // can't be clicked again mid-sequence and re-entrancy can't
    // stack multiple burst loops on top of each other.
    let burstRunning = false;

    // Small promise-based sleep helper — lets us `await` a pause
    // inside the async countdown loop below instead of nesting
    // setTimeout callbacks.
    function wait(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ----------------------------------------------------------------
    // CAPTURE PHOTO (extracted, reusable): SEQUENTIAL SLOT INDEXING
    // ----------------------------------------------------------------
    // Identical capture/mirror/store/broadcast logic as before — just
    // pulled out of the click handler into its own function so the
    // burst loop below can call it automatically once per countdown.
    function capturePhoto() {
      const w = video.videoWidth || 640;
      const h = video.videoHeight || 480;
      hiddenCanvas.width = w;
      hiddenCanvas.height = h;
      const ctx = hiddenCanvas.getContext('2d');

      // Bake in the same mirror flip the live preview shows (see the
      // original inline comments in earlier revisions for the full
      // explanation of translate/scale/drawImage here).
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, w, h);
      ctx.restore();

      // [แก้ไขเพื่อแก้บั๊ก 524] เปลี่ยนจาก 'image/png' (ไม่บีบอัดเลย
      // — ภาพเว็บแคมความละเอียดเต็ม 1 รูปอาจหนักหลาย MB) เป็น
      // 'image/jpeg' คุณภาพ 0.9 (บีบอัดแบบ lossy แต่ตาเปล่าแทบไม่
      // ต่างกันสำหรับภาพถ่าย) ลดขนาด payload ต่อรูปลงได้ 5-10 เท่า
      // เมื่อคูณด้วย 3 รูป + strip ที่ /api/strip ต้องอัปโหลดผ่าน
      // Cloudflare Tunnel ทีเดียว การลดขนาดนี้คือปัจจัยหลักที่ช่วย
      // ไม่ให้การอัปโหลดกิน เวลานานจนโดน Cloudflare ตัด connection
      // ที่ 100 วินาทีแล้วคืน 524 ให้ผู้ใช้
      const dataUrl = hiddenCanvas.toDataURL('image/jpeg', 0.9);

      slots[nextIndex] = dataUrl;
      renderAdminSlot(nextIndex, dataUrl);
      triggerFlash();

      socket.emit('admin-captured-photo', { index: nextIndex, dataUrl });

      const filledCount = slots.filter(s => s !== null).length;
      adminStatus.textContent = filledCount < SHOT_COUNT
        ? `Captured ${filledCount}/${SHOT_COUNT} — slot ${nextIndex + 1} sent to display.`
        : 'All 3 slots filled. Ready to export.';

      nextIndex = (nextIndex + 1) % SHOT_COUNT;
      exportBtn.disabled = !slots.every(s => s !== null);
    }

    // Restarts the CSS flash animation on demand (unchanged from
    // before — remove/reflow/re-add forces the animation to replay
    // every time instead of only on the first class-add).
    function triggerFlash() {
      flash.classList.remove('active');
      void flash.offsetWidth;
      flash.classList.add('active');
    }

    // ----------------------------------------------------------------
    // AUTOMATIC BURST SEQUENCE: 3 SHOTS, COUNTDOWN BEFORE EACH
    // ----------------------------------------------------------------
    // Runs SHOT_COUNT rounds. Each round: count down from
    // COUNTDOWN_SECONDS to 1 (emitting a "countdown-tick" socket
    // event every second so the Customer display can mirror the same
    // countdown), then calls capturePhoto() once the count hits 0.
    async function startBurstSequence() {
      if (!streamActive || burstRunning) return;
      burstRunning = true;
      captureBtn.disabled = true; // prevent re-triggering mid-burst

      for (let shot = 1; shot <= SHOT_COUNT; shot++) {
        for (let secondsLeft = COUNTDOWN_SECONDS; secondsLeft >= 1; secondsLeft--) {
          adminStatus.textContent = `Get ready — shot ${shot}/${SHOT_COUNT} in ${secondsLeft}...`;
          socket.emit('countdown-tick', { shot, secondsLeft, active: true });
          await wait(1000);
        }
        capturePhoto();
      }

      // Signal the countdown overlay to hide on the Customer display.
      socket.emit('countdown-tick', { active: false });
      burstRunning = false;
      captureBtn.disabled = !streamActive;
      adminStatus.textContent = 'Burst complete! Ready to export.';
    }

    // "Capture Photo" now starts the whole automatic burst instead of
    // taking a single manual shot.
    captureBtn.addEventListener('click', startBurstSequence);

    // --- LOCAL IMAGE RENDERING LOGIC (ADMIN SIDE) ---
    // Injects a freshly-captured photo into the Admin's own slot UI
    // (separate from, but parallel to, injectIntoSlot() used on the
    // Customer side further down this file).
    function renderAdminSlot(index, dataUrl) {
      const slotEl = document.getElementById('admin-slot-' + index);
      const preview = slotEl.querySelector('.slot-preview');
      preview.innerHTML = ''; // clear out the "Empty" placeholder text
      const img = document.createElement('img');
      img.src = dataUrl;
      preview.appendChild(img);
      slotEl.classList.add('filled'); // triggers the solid-border CSS state
    }

    // ----------------------------------------------------------------
    // SHARED: CLEAR ALL SLOTS (used by both "Reset Session" and the
    // checkout modal's "Start New Session" button)
    // ----------------------------------------------------------------
    // Extracted into one function so both entry points stay perfectly
    // in sync — wipes local state, resets the DOM, re-locks the
    // export button, and tells the Customer Display to clear its
    // Polaroids too.
    function clearAllSlots() {
      // Wipe all 3 in-memory slots back to null...
      slots[0] = slots[1] = slots[2] = null;
      // ...and reset the sequential pointer back to the start so the
      // next capture lands in slot 0 again.
      nextIndex = 0;
      exportBtn.disabled = true;

      // Reset each admin-side slot's DOM back to its empty state.
      [0, 1, 2].forEach((i) => {
        const slotEl = document.getElementById('admin-slot-' + i);
        slotEl.classList.remove('filled');
        slotEl.querySelector('.slot-preview').innerHTML = '<span>Empty</span>';
      });

      // Tell the Customer Display to clear its Polaroids too, so both
      // screens stay in sync for the next guest.
      socket.emit('session-reset');
    }

    // ----------------------------------------------------------------
    // RESET SESSION
    // ----------------------------------------------------------------
    resetBtn.addEventListener('click', () => {
      clearAllSlots();
      adminStatus.textContent = 'Session reset. Ready for new captures.';
    });

    // ----------------------------------------------------------------
    // LAUNCH CUSTOMER DISPLAY
    // ----------------------------------------------------------------
    launchCustomerBtn.addEventListener('click', () => {
      // Build a URL pointing at the SAME index.html but with
      // ?role=customer instead — window.location.pathname gives us
      // the current path (e.g. "/index.html") without the existing
      // query string, so we don't accidentally carry over
      // "?role=admin" into the new window's URL.
      const url = window.location.pathname + '?role=customer';

      // window.open(url, windowName, features) opens a new browser
      // window/tab. Passing a specific windowName
      // ("photoboothCustomerDisplay") means clicking the button again
      // later would reuse/refocus the SAME window instead of spawning
      // duplicates. The features string requests a specific starting
      // size, though the OS/browser may still let the user resize or
      // move it (e.g. onto a second monitor for the actual event).
      // [เปลี่ยน] เดิมไม่เก็บ return value ของ window.open() ไว้เลย
      // ตอนนี้เก็บไว้ในตัวแปร customerWindow ระดับบนของ runAdmin()
      // เพราะ pushStreamToCustomerWindow() ต้องใช้มันเข้าถึง
      // customerWindow.document ข้ามหน้าต่าง
      customerWindow = window.open(url, 'photoboothCustomerDisplay', 'width=1280,height=800');
      adminStatus.textContent = 'Customer display window launched.';

      // [ใหม่] ถ้ากล้องเปิดอยู่แล้วก่อนกดปุ่มนี้ (มี mediaStream
      // อยู่แล้ว) ให้เริ่ม retry-push ทันที เพื่อยัดสตรีมเข้าไปยัง
      // <video id="customer-webcam"> ของหน้าต่างที่เพิ่งเปิดใหม่ทันที
      // ที่ DOM ของมันพร้อม (ปกติภายในเสี้ยววินาที) — ถ้ากล้องยังไม่
      // เปิด ฟังก์ชันนี้จะ retry ไปเรื่อยๆ จนหมดเวลาเฉยๆ โดยไม่มีผล
      // เสียหายอะไร แล้วเมื่อกล้องถูกเปิดภายหลัง โค้ดใน openCameraBtn
      // จะ push ให้เองอีกที (ดูด้านบน)
      if (customerWindow) {
        retryPushStreamToCustomerWindow();
      }
    });

    // ----------------------------------------------------------------
    // EXPORT TO FRAME: CANVAS STITCHING + CHECKOUT MODAL (QR CODE)
    // ----------------------------------------------------------------
    exportBtn.addEventListener('click', () => {
      // Belt-and-suspenders guard: the button is already disabled
      // until all 3 slots are filled, but we re-check here in case
      // this handler is ever triggered programmatically.
      if (slots.some(s => s === null)) return;

      exportBtn.disabled = true; // prevent double-submitting the same session
      adminStatus.textContent = 'Building your strip…';

      // Delegate the actual drawing work to a shared helper function
      // (defined below, outside runAdmin, since it doesn't need any
      // Admin-specific closures). It builds the final strip image and
      // hands the finished data URL back to us via the callback —
      // it no longer auto-downloads on its own (see buildStripAndDownload
      // itself for that change).
      buildStripAndDownload(slots, stripCanvas, (finalDataUrl) => {
        // Broadcast the finished strip to the Customer Display so it
        // can show its "Thank you" closing overlay — unchanged from
        // before.
        socket.emit('export-complete', { dataUrl: finalDataUrl });

        // Show the strip immediately in the modal's left panel — this
        // is instant since it's just the local data URL, no network
        // wait needed for this half.
        checkoutStripImg.src = finalDataUrl;
        checkoutQrImg.src = ''; // clear any previous session's QR immediately
        checkoutQrHint.textContent = 'Generating your unique link…';
        checkoutModal.classList.add('show');

        // Upload the strip to the server so we get back a real,
        // short, unique URL a phone can actually open (see
        // server.js POST /api/strip) — a QR code cannot encode the
        // full image data itself at a scannable size.
        fetch('/api/strip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Now sends the strip AND all 3 individual shots in one
          // call — `slots` already holds each photo's data URL from
          // when they were originally captured, so this just passes
          // it along. server.js stores all 4 images under one
          // session id and returns a link to the download landing
          // page (download.html?session=<id>).
          body: JSON.stringify({
            stripDataUrl: finalDataUrl,
            photoDataUrls: slots
          })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Upload failed (' + res.status + ')');
            return res.json();
          })
          .then(({ id, url }) => {
            // [ใหม่] เก็บ id ไว้ และเปิดใช้งานปุ่ม backup ตอนนี้เอง
            // เพราะเป็นจังหวะแรกที่ "มีเซสชันจริงบน server ให้ backup"
            // — ก่อนหน้านี้ (ตอนแค่กด Export แต่ upload ยังไม่เสร็จ)
            // ปุ่มยังต้องถูก disabled อยู่ ป้องกันการกด backup ก่อนที่
            // จะมี session id จริง
            currentSessionId = id;
            cloudBackupBtn.disabled = false;
            cloudBackupStatus.textContent = '';

            // UNIQUE REFRESH GUARANTEE: `url` contains a brand-new
            // crypto.randomUUID() from the server for THIS session
            // only, so overwriting .src here with it fully replaces
            // any previous session's QR code — no stale image can
            // ever remain visible or scannable.
            const qrSrc =
              'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' +
              encodeURIComponent(url);
            checkoutQrImg.src = qrSrc;
            checkoutQrHint.textContent = 'Scan with your phone camera';
            adminStatus.textContent = 'Ready! Customer can scan the QR code.';

            // DUAL-SCREEN SYNC: broadcast the same strip + real
            // download URL to the Customer Display, so its own
            // checkout modal pops open showing the identical layout
            // at the same moment — not a separate/delayed reveal.
            socket.emit('broadcast-session-checkout', {
              stripDataUrl: finalDataUrl,
              downloadUrl: url
            });
          })
          .catch((err) => {
            checkoutQrHint.textContent = 'Could not generate a QR code — please retry.';
            adminStatus.textContent = 'Export upload failed: ' + err.message;
          });
      });
    });

    // ----------------------------------------------------------------
    // CHECKOUT MODAL: CLOSE / START NEW SESSION
    // ----------------------------------------------------------------
    // Both the "✕" corner button and the big "Start New Session"
    // button do the same thing: hide the modal, fully clear session
    // state via the shared clearAllSlots() helper, and unblock the
    // shutter button for the next guest.
    function closeCheckoutModal() {
      checkoutModal.classList.remove('show');
      clearAllSlots(); // also emits 'session-reset', clearing the Customer's Polaroid slots
      captureBtn.disabled = !streamActive; // re-enable the shutter (unless the camera itself is off)

      // [ใหม่] เซสชันนี้จบแล้ว — ปิดปุ่ม backup และเคลียร์ id ทิ้ง
      // ป้องกันไม่ให้กด backup เซสชันเก่าซ้ำหลังเริ่มเซสชันใหม่แล้ว
      currentSessionId = null;
      cloudBackupBtn.disabled = true;
      cloudBackupStatus.textContent = '';

      adminStatus.textContent = streamActive
        ? 'Ready for the next guest — camera is live.'
        : 'Ready for the next guest — open the camera to begin.';

      // DUAL-SCREEN SYNC: the Customer's modal has no close button of
      // its own — this is the ONLY way it ever closes, and it closes
      // at the exact same instant the Admin's does.
      socket.emit('admin-dismiss-checkout');
    }

    checkoutCloseX.addEventListener('click', closeCheckoutModal);
    checkoutStartNewBtn.addEventListener('click', closeCheckoutModal);

    // ----------------------------------------------------------------
    // [ใหม่] CLOUD BACKUP: "บันทึกรูปและวิดีโอลงไดร์ฟ"
    // ----------------------------------------------------------------
    // เงื่อนไขสำคัญ (CRITICAL CONDITION) ที่ต้องรักษาไว้ทุกกรณี:
    //   - ห้ามแตะ checkoutModal.classList เลย (ไม่ปิด ไม่เปิดซ้ำ)
    //   - ห้ามเรียก clearAllSlots() หรือ emit 'session-reset' ใดๆ
    //   - ห้ามยุ่งกับ customerWindow หรือ socket event ที่กระทบจอ
    //     Customer เลยแม้แต่นิดเดียว
    // ฟังก์ชันนี้จึงเป็นแค่ fetch() เดี่ยวๆ ที่ไม่แตะ state อื่นใน
    // หน้าเลยนอกจากข้อความสถานะของปุ่มตัวเอง — จอทั้งสองฝั่งจึงยังคง
    // แสดง QR code / checkout modal ค้างอยู่เหมือนเดิมทุกประการ
    // ระหว่างที่ request นี้กำลังทำงาน
    cloudBackupBtn.addEventListener('click', () => {
      if (!currentSessionId) return; // ปุ่มควร disabled อยู่แล้วในเคสนี้ แต่กันเหนียวไว้

      cloudBackupBtn.disabled = true;
      cloudBackupStatus.textContent = 'กำลังบันทึกลงไดร์ฟ…';

      fetch('/api/backup-to-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId })
      })
        .then((res) => {
          if (!res.ok) throw new Error('Backup failed (' + res.status + ')');
          return res.json();
        })
        .then((result) => {
          // [ใหม่] บอกตามจริงว่ามีวิดีโอรวมไปด้วยหรือไม่ — ปัจจุบัน
          // ไม่มีไฟล์วิดีโออยู่บน server เลย (ดูคำอธิบายยาวใน
          // server.js ที่ POST /api/backup-to-drive) ผลลัพธ์ที่ถูก
          // backup จริงตอนนี้คือ strip + รูป 3 ใบเท่านั้น
          cloudBackupStatus.textContent = result.videoIncluded
            ? '✅ บันทึกรูปและวิดีโอลงไดร์ฟเรียบร้อย'
            : '✅ บันทึกรูป 3 ใบ + สตริปลงไดร์ฟเรียบร้อย (ยังไม่มีไฟล์วิดีโอให้บันทึก — ดูรายละเอียดใน server.js)';
          cloudBackupBtn.disabled = false;
        })
        .catch((err) => {
          cloudBackupStatus.textContent = '❌ บันทึกไม่สำเร็จ: ' + err.message;
          cloudBackupBtn.disabled = false;
        });
    });

    // ----------------------------------------------------------------
    // UX SAFEGUARD: WARN BEFORE LOSING AN IN-PROGRESS SESSION
    // ----------------------------------------------------------------
    // The 'beforeunload' event fires right before the browser
    // actually navigates away from / closes / reloads this page.
    // Calling preventDefault() AND setting e.returnValue to a
    // (non-empty, though browsers ignore the actual text nowadays)
    // string together trigger the browser's native "Leave site?"
    // confirmation dialog. We only do this if at least one photo has
    // been captured, so an Admin who hasn't started a session yet can
    // navigate freely.
    window.addEventListener('beforeunload', (e) => {
      const anyPhoto = slots.some(s => s !== null);
      if (anyPhoto) {
        e.preventDefault();
        e.returnValue = '';
        return '';
      }
    });
  }

  /* ==================================================================
     CUSTOMER ROLE
     ==================================================================
     A much smaller, purely REACTIVE set of logic: this side never
     touches the camera directly and has no buttons — it only listens
     for socket events sent by the Admin and updates its own DOM in
     response. */
  function runCustomer() {
    // Same pattern as the Admin: open a Socket.io connection back to
    // this same server. Both this socket and the Admin's socket end
    // up in the same shared "photobooth-session" room (server.js
    // handles that automatically on connection).
    const socket = io();

    // [ลบ] เดิมมี const liveFeedImg = document.getElementById('liveFeedImg')
    // อยู่ตรงนี้ — ไม่ต้องใช้แล้วเพราะ <img id="liveFeedImg"> ถูก
    // แทนที่ด้วย <video id="customer-webcam"> ใน index.html ซึ่ง
    // ฝั่ง Admin เป็นคนเขียน .srcObject ใส่โดยตรงข้ามหน้าต่าง (ดู
    // pushStreamToCustomerWindow ใน runAdmin()) โค้ดฝั่งนี้จึง "ไม่
    // ต้องทำอะไรเลย" กับวิดีโอสด — ไม่ต้องมี element reference, ไม่
    // ต้องมี socket listener ใดๆ สำหรับมันอีกต่อไป (รวมถึง
    // #liveFeedPlaceholder ก็ไม่ต้องมีตัวแปรอ้างอิงในไฟล์นี้แล้ว
    // เพราะฝั่ง Admin เป็นคนซ่อน/แสดงมันโดยตรงข้ามหน้าต่าง)
    const completeOverlay = document.getElementById('completeOverlay');
    const completeImg = document.getElementById('completeImg');
    const countdownOverlay = document.getElementById('countdownOverlay');
    const countdownNumber = document.getElementById('countdownNumber');
    const countdownShotLabel = document.getElementById('countdownShotLabel');
    const customerCheckoutModal = document.getElementById('customerCheckoutModal');
    const customerCheckoutStripImg = document.getElementById('customerCheckoutStripImg');
    const customerCheckoutQrImg = document.getElementById('customerCheckoutQrImg');
    const customerCheckoutQrHint = document.getElementById('customerCheckoutQrHint');

    // [ลบทั้งบล็อก] เดิมตรงนี้คือ socket.on('sync-camera-state', ...)
    // ที่คอยรับเฟรม JPEG แล้วยัดใส่ liveFeedImg.src — ถูกลบออกทั้งหมด
    // ตามสถาปัตยกรรมใหม่ เพราะภาพวิดีโอสดตอนนี้มาจาก MediaStream ที่
    // ฝั่ง Admin เขียนตรงเข้า <video id="customer-webcam">.srcObject
    // ข้ามหน้าต่างโดยตรง (ดู pushStreamToCustomerWindow() ใน
    // runAdmin()) — จอลูกค้าฝั่งนี้จึง "ไม่ต้องรับหรือประมวลผล"
    // เฟรมวิดีโอใดๆ ผ่าน socket อีกเลย ทำให้ค่า placeholder
    // (#liveFeedPlaceholder) ก็ถูกซ่อน/แสดงโดย Admin โดยตรงเช่นกัน
    // ไม่ใช่หน้าที่ของ runCustomer() อีกต่อไป

    // [แก้ไข] REPLAY STATE ON (RE)CONNECT — แก้ต้นตอจริงของบั๊ก
    // "Captured Photos Missing"
    // ------------------------------------------------------------
    // ก่อนหน้านี้จอ Customer ไม่มีทางรู้เลยว่ามีรูปที่ Admin ถ่ายไป
    // แล้วก่อนหน้าที่ตัวเองจะเชื่อมต่อ (เช่น เปิดหน้าต่าง Customer
    // ทีหลัง หรือหลุดการเชื่อมต่อผ่าน Cloudflare Tunnel แล้วต่อใหม่
    // ระหว่าง session) เพราะเหตุการณ์ 'admin-captured-photo' เดิม
    // เป็นแค่ signal สดๆ ที่ relay ผ่าน server ครั้งเดียวตอนเกิดขึ้น
    // เท่านั้น ไม่มีการเก็บสถานะไว้ replay ย้อนหลังเลย
    //
    // ตอนนี้ server.js ส่ง event 'sync-state' กลับมาให้ทุกครั้งที่
    // socket นี้เชื่อมต่อ (รวมถึงตอน auto-reconnect ของ socket.io
    // เองด้วย) พร้อมสถานะล่าสุดของทั้ง 3 ช่อง + checkout ที่ค้างอยู่
    // (ถ้ามี) — ทำให้จอนี้ "ตามทัน" สถานะจริงเสมอไม่ว่าจะพลาด
    // เหตุการณ์สดๆ ไปกี่ครั้งก็ตาม
    socket.on('sync-state', (payload) => {
      if (!payload) return;

      if (Array.isArray(payload.slots)) {
        payload.slots.forEach((dataUrl, i) => {
          if (dataUrl) injectIntoSlot(i, dataUrl);
        });
      }

      if (payload.checkout && payload.checkout.stripDataUrl && payload.checkout.downloadUrl) {
        customerCheckoutStripImg.src = payload.checkout.stripDataUrl;
        customerCheckoutQrImg.src =
          'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' +
          encodeURIComponent(payload.checkout.downloadUrl);
        customerCheckoutQrHint.textContent = 'Scan with your phone camera';
        customerCheckoutModal.classList.add('show');
      }
    });

    // --- COUNTDOWN OVERLAY TOGGLE ---
    // Fires once per second during the Admin's automatic burst
    // sequence. { active:false } (sent once the burst finishes) hides
    // the overlay again.
    socket.on('countdown-tick', (payload) => {
      if (!payload) return;

      if (payload.active === false) {
        countdownOverlay.classList.remove('show');
        return;
      }

      countdownOverlay.classList.add('show');
      countdownNumber.textContent = payload.secondsLeft;
      countdownShotLabel.textContent = `Shot ${payload.shot} of 3`;

      // Same remove/reflow/re-add trick as the Admin's flash effect —
      // forces the CSS "pulse" animation to replay on every tick,
      // not just the first one.
      countdownNumber.classList.remove('tick');
      void countdownNumber.offsetWidth;
      countdownNumber.classList.add('tick');
    });

    // --- DYNAMIC SLOT INJECTION ---
    // Fires once per "Capture Photo" click on the Admin side. The
    // payload's `index` tells us exactly which of the 3 Polaroid
    // slots this photo belongs in — we never have to guess or track
    // our own separate counter, since the Admin is the single source
    // of truth for slot assignment.
    socket.on('admin-captured-photo', (payload) => {
      if (!payload) return;
      injectIntoSlot(payload.index, payload.dataUrl);
    });
    
    // --- SESSION COMPLETE OVERLAY ---
    socket.on('export-complete', (payload) => {
      if (!payload) return;
      completeImg.src = payload.dataUrl;
      completeOverlay.classList.add('show'); // fades the overlay in (CSS transition)
      // Auto-hide the "Thank you" overlay again after 5 seconds so
      // the screen resets itself for the next guest without needing
      // any manual dismissal.
      setTimeout(() => completeOverlay.classList.remove('show'), 5000);
    });

    // --- SYNCHRONIZED CHECKOUT MODAL (mirrors the Admin's) ---
    // Fires once, right after the Admin's strip upload succeeds.
    // Builds the exact same QR code client-side using the SAME
    // downloadUrl the Admin just got back from the server — no extra
    // network round-trip needed here, since qrserver.com's QR image
    // API is just a URL, and the Admin already sent us the real one.
    socket.on('broadcast-session-checkout', (payload) => {
      if (!payload) return;

      customerCheckoutStripImg.src = payload.stripDataUrl;
      customerCheckoutQrImg.src =
        'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' +
        encodeURIComponent(payload.downloadUrl);
      customerCheckoutQrHint.textContent = 'Scan with your phone camera';

      customerCheckoutModal.classList.add('show');
    });

    // --- ADMIN-ONLY DISMISSAL: closes the Customer's modal in sync ---
    // The Customer has no close button of their own (by design) —
    // this socket event, sent only when the Admin dismisses their
    // own copy, is the only way this modal ever closes.
    socket.on('admin-dismiss-checkout', () => {
      customerCheckoutModal.classList.remove('show');
    });

    // --- SESSION RESET ---
    socket.on('session-reset', () => {
      [0, 1, 2].forEach((i) => {
        const polaroid = document.getElementById('cust-slot-' + i);
        polaroid.classList.remove('pop'); // stop showing any photo/animation state
        const inner = polaroid.querySelector('.polaroid-inner');
        inner.innerHTML = `<span>${i + 1}</span>`; // restore the plain number placeholder
      });
      completeOverlay.classList.remove('show');
    });

    // --- LOCAL IMAGE RENDERING LOGIC (CUSTOMER SIDE) ---
    // Builds a fresh <img>, drops it into the target Polaroid's inner
    // box, and triggers the CSS "pop" entry animation defined in
    // style.css (.polaroid.pop .polaroid-inner img { animation: ... }).
    function injectIntoSlot(index, dataUrl) {
      const polaroid = document.getElementById('cust-slot-' + index);
      if (!polaroid) return; // safety check in case of an unexpected index

      const inner = polaroid.querySelector('.polaroid-inner');
      inner.innerHTML = ''; // clear the placeholder number span
      const img = document.createElement('img');
      img.src = dataUrl;
      inner.appendChild(img);

      // Same "remove, force reflow, re-add" trick used for the
      // Admin's flash effect — guarantees the pop animation replays
      // even if this exact slot was already popped once before (e.g.
      // a retake overwriting slot 0 a second time in the same
      // session, before a reset).
      polaroid.classList.remove('pop');
      void polaroid.offsetWidth;
      polaroid.classList.add('pop');
    }
  }

  /* ==================================================================
     SHARED HELPER: CANVAS STRIP STITCHING (used only by the Admin)
     ==================================================================
     Takes the 3 captured photo data URLs and composites them, along
     with decorative branding text, onto one tall canvas representing
     a physical photobooth strip — then converts that canvas to a PNG
     and triggers a browser download.
     Defined at the bottom of the file (outside runAdmin) since it's a
     pure function that only needs its arguments — no access to
     Admin-specific closures like `socket` or `slots` directly. */
  function buildStripAndDownload(slots, stripCanvas, onDone) {
    // --- LAYOUT CONFIGURATION ---
    // These constants now describe the pre-designed Canva frame asset
    // rather than driving any generated background/text. Update
    // FRAME_W / FRAME_H to match the actual pixel dimensions of
    // my_canva_frame.png whenever the asset changes.
    const FRAME_PATH = 'assets/SMABU.png'; // transparent overlay, relative to public/
    const FRAME_W = 600;   // frame asset width  (= final canvas width)
    const FRAME_H = 1800;  // frame asset height (= final canvas height)

    // Explicit per-slot bounding boxes for the 3 captured photos, in
    // canvas pixel coordinates. These correspond to the transparent
    // "window" cutouts in the Canva frame — tweak x/y/width/height
    // here to nudge alignment without touching any drawing logic.
    const SLOT_LAYOUT = [
      { x: 30, y: 247,  width: 539, height: 382 },
      { x: 30, y: 674,  width: 539, height: 382 },
      { x: 30, y: 1098, width: 539, height: 382 },
    ];

    stripCanvas.width = FRAME_W;
    stripCanvas.height = FRAME_H;
    const ctx = stripCanvas.getContext('2d');

    // --- LOADING THE 3 CAPTURED IMAGES + THE FRAME OVERLAY ---
    // Canvas drawImage() requires an actual loaded Image object, not
    // just a raw data URL/path string. We load the 3 photos and the
    // frame PNG in parallel and only draw once everything (4 assets
    // total) has finished loading.
    const TOTAL_ASSETS = slots.length + 1; // 3 photos + 1 frame
    let loaded = 0;
    const imgs = [];

    function assetReady() {
      loaded++;
      if (loaded === TOTAL_ASSETS) draw();
    }

    slots.forEach((dataUrl, i) => {
      const img = new Image();
      img.onload = () => {
        imgs[i] = img; // keep each image in its correct slot position
        assetReady();
      };
      img.src = dataUrl; // for data: URLs this is effectively instant, but still async
    });

    const frameImg = new Image();
    frameImg.onload = assetReady;
    frameImg.onerror = () => {
      adminStatus.textContent = 'โหลดไฟล์เฟรมไม่สำเร็จ — เช็คว่ามีไฟล์ที่ public/' + FRAME_PATH;
      exportBtn.disabled = false; // ให้กดลองใหม่ได้หลังแก้ปัญหา
    };
    frameImg.src = FRAME_PATH;

    // --- DRAWING: PHOTOS UNDER THE FRAME MASK ---
    function draw() {
      // Layer 1 (bottom): the 3 captured photos, each cropped/scaled
      // via drawImageCover to exactly fill its slot box — no
      // stretching, no gaps, matching the live preview's
      // object-fit: cover behavior.
      imgs.forEach((img, i) => {
        const slot = SLOT_LAYOUT[i];
        drawImageCover(ctx, img, slot.x, slot.y, slot.width, slot.height);
      });

      // Layer 2 (top overlay): the Canva frame, stretched to cover
      // the full canvas. Since it's a transparent PNG with opaque
      // borders and cut-out windows, this masks any overflow from
      // the cover-cropped photos underneath and supplies all
      // branding/decoration — no canvas-drawn text or shapes needed.
      ctx.drawImage(frameImg, 0, 0, FRAME_W, FRAME_H);

      // --- CONVERT TO IMAGE ---
      // PNG (not JPEG) to preserve the frame's alpha channel and the
      // sharp edges of the imported vector artwork.
      const finalDataUrl = stripCanvas.toDataURL('image/png');

      // Hand the finished data URL back to whoever called
      // buildStripAndDownload (the Admin's export handler), so it can
      // broadcast it to the Customer Display and drive the checkout
      // modal / QR upload.
      if (onDone) onDone(finalDataUrl);
    }
  }

  // --------------------------------------------------------------
  // HELPER: drawImageCover
  // --------------------------------------------------------------
  // Canvas's built-in drawImage(img, dx, dy, dw, dh) STRETCHES the
  // source image to exactly fill the destination box, distorting its
  // aspect ratio if the source and destination proportions don't
  // match. This helper instead replicates CSS's `object-fit: cover`
  // behavior: it crops the LARGER dimension of the source image so
  // that what remains has the exact same aspect ratio as the
  // destination box, then draws that cropped region scaled to fit
  // perfectly — filling the box completely with no empty space and
  // no stretching, just like the live preview's object-fit:cover CSS.
  function drawImageCover(ctx, img, dx, dy, dw, dh) {
    const iw = img.width, ih = img.height;       // source image's natural size
    const targetRatio = dw / dh;                  // destination box's aspect ratio
    const imgRatio = iw / ih;                      // source image's aspect ratio

    let sx, sy, sw, sh; // the source rectangle we'll crop out of the original image

    if (imgRatio > targetRatio) {
      // Source is proportionally WIDER than the target box: keep the
      // full height, crop equal amounts off the left and right sides.
      sh = ih;
      sw = ih * targetRatio;
      sx = (iw - sw) / 2; // center the crop horizontally
      sy = 0;
    } else {
      // Source is proportionally TALLER (or equal) than the target
      // box: keep the full width, crop equal amounts off the top and
      // bottom.
      sw = iw;
      sh = iw / targetRatio;
      sx = 0;
      sy = (ih - sh) / 2; // center the crop vertically
    }

    // drawImage's 9-argument form: draw the (sx,sy,sw,sh) region of
    // the SOURCE image, scaled to exactly fill the (dx,dy,dw,dh)
    // region of the DESTINATION canvas.
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }
})();