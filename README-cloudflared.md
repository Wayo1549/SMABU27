# วิธีการดาวน์โหลดและติดตั้ง `cloudflared.exe` ใหม่

หากคุณได้ทำการลบไฟล์ `cloudflared.exe` ออกจากโปรเจกต์ และต้องการดาวน์โหลดกลับมาใช้งานสำหรับระบบรักษาความปลอดภัยหรือการทำ Tunnel สามารถทำตามวิธีด้านล่างนี้ได้เลยครับ

---

## 📥 วิธีที่ 1: ดาวน์โหลดผ่านลิงก์โดยตรง (แนะนำ)
คุณสามารถคลิกดาวน์โหลดเวอร์ชันล่าสุดสำหรับ Windows (64-bit) ได้โดยตรงจากทางค่าย Cloudflare:
👉 **[ดาวน์โหลด cloudflared-windows-amd64.exe](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe)**

### 💡 ขั้นตอนหลังจากดาวน์โหลด:
1. เมื่อดาวน์โหลดเสร็จแล้ว คุณจะได้ไฟล์ชื่อ `cloudflared-windows-amd64.exe`
2. ให้ทำการ**เปลี่ยนชื่อไฟล์ (Rename)** ให้เหลือแค่ **`cloudflared.exe`**
3. ย้ายไฟล์นี้ไปวางไว้ที่โฟลเดอร์หลัก (Root Directory) ของโปรเจกต์คุณ (`E:\SMABU\SMA\SmaBU`) คู่กับไฟล์ `server.js` เพื่อให้สคริปต์รันทำงานต่อได้ทันที

---

## 💻 วิธีที่ 2: ดาวน์โหลดผ่าน Terminal (PowerShell)
หากเปิดหน้า VS Code อยู่ สามารถคัดลอกคำสั่งด้านล่างนี้ไปวางใน PowerShell แล้วกด `Enter` ระบบจะทำการโหลดและเปลี่ยนชื่อให้โดยอัตโนมัติ:

```powershell
Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile "cloudflared.exe"
```

---

## 🔒 คำแนะนำเพิ่มเติมสำหรับ Git
เนื่องจากไฟล์ `cloudflared.exe` มีขนาดใหญ่ประมาณ 52MB และระบบ Git มีการแจ้งเตือน หากคุณไม่อยากให้มันถูกอัปโหลดขึ้น GitHub ในครั้งต่อไป สามารถนำชื่อไปใส่ไว้ในไฟล์ `.gitignore` ได้ครับ

*This is for informational purposes only. For medical advice or diagnosis, consult a professional. AI responses may include mistakes.*
