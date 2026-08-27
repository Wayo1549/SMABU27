# Dual-Screen Photobooth

Educational reference implementation ของระบบ Photobooth สองหน้าจอ (Admin Controller + Customer Display) สร้างด้วย Express และ Socket.io

## ⚠️ คำเตือนก่อนรัน (อ่านก่อน)

โปรเจกต์นี้**ยังใช้งานไม่ได้ทันทีหลังดาวน์โหลด** ต้องเตรียมสภาพแวดล้อมตามลำดับด้านล่างก่อน มิเช่นนั้นจะรันไม่ขึ้นหรือกล้องเว็บแคมจะไม่ทำงาน

---

## 1. ติดตั้ง Node.js ก่อน

โปรเจกต์นี้ต้องใช้ **Node.js เวอร์ชัน 16 ขึ้นไป** (กำหนดไว้ใน `package.json`: `"engines": { "node": ">=16.0.0" }`)

- ดาวน์โหลดได้ที่ https://nodejs.org (แนะนำเวอร์ชัน LTS)
- ตรวจสอบว่าติดตั้งสำเร็จด้วยคำสั่ง:
  ```
  node -v
  npm -v
  ```

## 2. ติดตั้ง Dependencies ด้วย npm install

ไฟล์ที่ให้มามีเพียง `package.json` และ `package-lock.json` แต่ยังไม่มีโฟลเดอร์ `node_modules` ต้องรันคำสั่งนี้ในโฟลเดอร์โปรเจกต์ก่อนใช้งานทุกครั้งที่ดาวน์โหลดใหม่:

```bash
npm install
```

คำสั่งนี้จะติดตั้งแพ็กเกจหลัก `express` และ `socket.io` รวมถึง `nodemon` (สำหรับโหมด dev) ให้อัตโนมัติ

## 3. โหลดไฟล์ cloudflared.exe

ดาวน์โหลดไฟล์จากลิงก์นี้:

```
https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
```

จากนั้น:

1. ให้ทำการ **เปลี่ยนชื่อไฟล์ (Rename)** ให้เหลือแค่ **`cloudflared.exe`**
2. ย้ายไฟล์นี้ไปวางไว้ที่โฟลเดอร์ข้างๆ คู่กับไฟล์ `server.js` เพื่อให้สคริปต์รันทำงานต่อได้ทันที

> ลิงก์นี้เป็นไฟล์สำหรับ **Windows เท่านั้น** หากใช้เครื่อง Mac หรือ Linux ต้องไปดาวน์โหลด `cloudflared` เวอร์ชันของระบบปฏิบัติการนั้นจาก [github.com/cloudflare/cloudflared/releases](https://github.com/cloudflare/cloudflared/releases) แล้วแก้ path ในไฟล์ `start.js` ให้ตรงกับไฟล์ที่โหลดมา

## 4. โฟลเดอร์เก็บไฟล์ backup (photobooth_backups)

ไม่ต้องสร้างโฟลเดอร์นี้เอง — `server.js` ใช้ `fsp.mkdir(path, { recursive: true })` ซึ่งจะสร้างโฟลเดอร์ `photobooth_backups` และโฟลเดอร์ย่อยของแต่ละเซสชันให้อัตโนมัติเมื่อมีการบันทึกภาพครั้งแรก

ค่าเริ่มต้นจะอยู่ข้างๆ `server.js` เว้นแต่จะตั้งค่า environment variable `PHOTOBOOTH_BACKUP_ROOT` เพื่อเปลี่ยนตำแหน่งจัดเก็บ (เช่น ไปยัง external SSD)

## 5. ข้อกำหนดเรื่องกล้องเว็บแคม (สำคัญมาก)

โค้ดฝั่ง Admin ใช้ `navigator.mediaDevices.getUserMedia()` เพื่อเปิดกล้อง ซึ่งเบราว์เซอร์จะ**อนุญาตเฉพาะเมื่อเข้าเว็บผ่าน HTTPS หรือ localhost เท่านั้น**

- ถ้าเปิดผ่าน HTTP ธรรมดา (เช่น `http://192.168.x.x:3000` จากเครื่องอื่นในวง LAN) กล้องจะไม่ทำงาน
- นี่คือเหตุผลที่โปรเจกต์นี้เตรียม cloudflared tunnel มาให้ เพราะ tunnel จะสร้าง URL แบบ `https://xxxx.trycloudflare.com` ให้อัตโนมัติ

## 6. สิ่งที่ไม่ต้องเตรียมเพิ่ม

- ไม่มีการใช้ฐานข้อมูล (database) ใดๆ
- ไม่มีการใช้ไลบรารีประมวลผลภาพ/วิดีโอภายนอก เช่น ffmpeg หรือ sharp
- ไม่มีการโหลด CDN ภายนอก นอกจาก `/socket.io/socket.io.js` ซึ่ง server เสิร์ฟให้เองผ่านแพ็กเกจ socket.io ที่ติดตั้งไว้แล้ว

---

## ลำดับขั้นตอนการรันจริง

```bash
npm install              # รันครั้งแรกครั้งเดียว หรือทุกครั้งที่ package.json เปลี่ยน
npm start                # รันแบบ local เท่านั้น เปิดได้ที่ http://localhost:3000
# หรือ
npm run start:tunnel     # รันพร้อมเปิด public HTTPS URL ผ่าน cloudflared
                          # (จำเป็นถ้าต้องการให้กล้องทำงานได้จากเครื่อง/มือถือเครื่องอื่น)
```

หลังรันสำเร็จ ให้เปิดหน้า Admin ที่ URL ตามที่ `start.js` พิมพ์ในคอนโซล ต่อท้ายด้วย:

```
/index.html?role=admin
```
