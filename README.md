# NotePad

An offline notebook for pen and typed notes, with one web app for iPad/Samsung
and a self-hosted SQLite sync server.

- **Web:** https://singtoblood-s.github.io/native-notes/
- **Source:** https://github.com/singtoblood-s/native-notes
- **Releases:** https://github.com/singtoblood-s/native-notes/releases

## ใช้งานบน iPad และ Samsung

เปิดเว็บด้านบนด้วย Safari บน iPad หรือ Chrome บน Samsung แล้วเพิ่มไปยังหน้าจอหลัก
เปิดเว็บออนไลน์ครั้งแรกให้โหลดเสร็จก่อนใช้งาน offline
เว็บใช้ปากกาผ่าน Pointer Events ของเบราว์เซอร์ ความสามารถและความลื่นขึ้นกับ OS/เบราว์เซอร์/ปากกา
เว็บไม่ได้ใช้ Apple PencilKit และไม่ได้มีสิทธิ์เท่ากับแอป Notes ของระบบ

ข้อมูลจดในเครื่องและข้อมูลบัญชีเป็นคนละพื้นที่กัน การล้างข้อมูลเว็บไซต์หรือถอนการติดตั้งอาจทำให้โน้ตในเครื่องหาย
ใช้ Export archive เก็บสำเนาที่นำกลับมาแก้ไขได้เป็นระยะ โดยเฉพาะก่อนย้ายอุปกรณ์หรือเปลี่ยนเบราว์เซอร์

GitHub Pages ให้บริการหน้าเว็บเท่านั้น การ login และ sync ต้องใช้ URL ของ backend ที่เปิดอยู่
ต้องล็อกอินก่อนเปิดสมุด ไม่มีโหมด guest และเมื่อล็อกเอาต์หรือ session หมดอายุจะต้องล็อกอินใหม่
เมื่อเปิดเวอร์ชันใหม่ แอปจะลบฐานข้อมูล guest เก่าในเบราว์เซอร์และไม่มีฟังก์ชันกู้คืนหรือส่งออก guest
หาก session ยังใช้ได้ จะบันทึกในเครื่องขณะออฟไลน์และส่งเมื่อกลับมาออนไลน์
การทดสอบในเครื่องใช้ Cloudflare Worker/D1 ที่รันแยกจาก Vite; production ต้องชี้ไปยัง backend HTTPS ที่เปิดใช้งานจริง
ไม่มีการซื้อ hosting หรือ Apple Developer Program สำหรับโครงการนี้

เปิดแอปแล้วจะพบหน้า Documents เพื่อเลือกสมุดก่อนเข้าเขียน สร้างสมุดผ่าน New → Notebook → เลือกกระดาษ/ตั้งชื่อ → Create
กดปกเพื่อเปิดสมุด และกด Documents ในหน้าจอเขียนเพื่อกลับคลัง มีค้นหา เรียงลำดับ มุมมองรายการ และ Favorites (บันทึกเฉพาะอุปกรณ์นี้)
หน้าจอเขียนเปิดเต็มพื้นที่โดยซ่อนรายชื่อหน้าและแผงข้อความไว้ก่อน กดชื่อสมุดด้านบนเพื่อเปลี่ยนชื่อ
กดเมนู ⋯ ข้างชื่อสมุดหรือหน้าเพื่อ Rename, Duplicate และ Trash/Restore โดยไม่ต้องเปิด Text; กดชื่อหน้าเพื่อเปิดรายละเอียดหน้า ใช้นิ้วสองนิ้วซูมและหนึ่งนิ้วเลื่อนกระดาษ
แถบเขียนมีปากกา Fountain/Ball, ไฮไลต์, ยางลบทั้งเส้น, เส้นตรง และโหมดอ่าน/เลื่อน
สีและความหนาจำแยกตามเครื่องมือ ปุ่มลูกศรเปลี่ยนหน้า และปุ่ม ＋ เพิ่มหน้าด้วยกระดาษแบบเดิม
เปิด Text เพื่อเพิ่มรูปจากไฟล์หรือ clipboard, ย้าย/ย่อขยาย/ลบรูป และทำสำเนาหน้าพร้อมลายเส้น ข้อความ และรูป ดู [ผลวิจัย GoodNotes 5 และขอบเขตที่ทำแล้ว](docs/GOODNOTES5-RESEARCH.md)
ลบรูปที่เลือกได้ด้วยปุ่ม × บนรูป หรือ Delete/Backspace; เลือกรูปเดิมผ่านโหมด Read หรือรายการ Images ใน Text (รวมถึงรูปพื้นหลังเต็มหน้า)
New → Picture / PDF สร้างสมุดจากไฟล์ได้ และปุ่ม Insert (⊕) ในหน้าจดเพิ่มรูปหรือ PDF ลงสมุดเดิมได้
ใช้ Ctrl/Cmd+V หรือกดค้างบนกระดาษเพื่อวางรูป/ข้อความ; Copy image อยู่ใน Text เมื่อเลือกรูป
ปุ่ม Export (↥) หรือเมนู ⋯ ส่ง PNG หน้าปัจจุบัน หรือ PDF หน้าปัจจุบัน/ทั้งสมุดได้โดยตรง
PDF นำเข้าเป็นพื้นภาพพร้อมลายเส้นที่แก้ได้ ไม่เก็บเวกเตอร์/ฟอร์ม/ลิงก์ต้นฉบับ; ครั้งละไม่เกิน 100 หน้า
รองรับรูปต้นฉบับไม่เกิน 50 MiB และ PDF ไม่เกิน 250 MiB โดยบีบอัดภาพอัตโนมัติ; PDF อ่านเป็นส่วน ๆ และประมวลผลทีละหน้า
ภาพที่บันทึกอาจลดความละเอียดเพื่อให้ sync ผ่านเน็ตมือถือได้เร็วขึ้น โดยไม่เปลี่ยนไฟล์ต้นฉบับ
รูปที่แทรกใหม่ใช้คุณภาพเดิม: ด้านยาวไม่เกิน 2,000 พิกเซล และไม่เกิน 512 KiB ต่อรูป โดยเข้ารหัสแบบอะซิงโครนัส; รูปที่บันทึกไว้ก่อนหน้านี้ไม่ถูกบีบอัดย้อนหลัง
ดู [การแก้ไฟล์ใหญ่และ sync บนมือถือ พร้อม edge cases](docs/MEDIA_SYNC_RELIABILITY.md)
ดู [แผน Checklist ผลตรวจ และข้อจำกัด](docs/EDITOR_POLISH_CHECKLIST.md)
เลือก Continuous, Book scroll หรือ Page turn ในแถบหน้า; ค่าจะจำแยกตามบัญชีบนอุปกรณ์นั้น
เมื่อเข้าสู่ระบบ แอปส่งข้อมูลหลังบันทึกและดึงข้อมูลเมื่อกลับมาเปิดแอป/กลับมาออนไลน์
รวมถึงตรวจทุก 5 วินาทีขณะเปิดแอปอยู่เบื้องหน้า สถานะบันทึกในเครื่องยังไม่ใช่การยืนยันว่าส่งถึงเครื่องอื่นแล้ว

## Project layout

| Directory | Responsibility |
| --- | --- |
| `webApp/` | Installable web app, browser ink and local SQLite |
| `shared/` | Kotlin JSON models shared with the server's tests |
| `server/` | Authentication and SQLite revision-sync API |
| `docs/CONTRACT.md` | Shared JSON format and API contract |
| `docs/USER_REPAIR_2026-09-11.md` | User-facing repair behavior and device checks |
| `PLAN.md` | Original architecture plan; see the change record below |

## Development

The web app uses Node.js and npm. The server uses JDK 21 and the checked-in
Gradle wrapper. No Android SDK, Mac or Apple development account is needed.

```sh
cd webApp
npm ci
npm test
npm run build
npm run dev
```

```sh
./gradlew :server:test
./gradlew :server:installDist
```

On Windows use `gradlew.bat`. Set `JAVA_HOME` to your JDK 21 installation.

See [server deployment](server/README.md) and [local testing](docs/TESTING.md) for persistent storage, TLS, origin
configuration and backup. A static GitHub Pages deployment cannot run the API.
Never commit real databases, note exports, session tokens, credentials or
Android signing keys. The repository's ignore rules exclude local databases
and build outputs.

## Data and sync rules

- A local save must be durable before the interface reports it as saved.
- Each account has isolated local data. A server identity is scoped to its
  server URL, not just the email typed into a login form.
- Sync uses immutable operation IDs and server revisions. Device clocks do
  not decide who wins.
- Concurrent changes keep alternate snapshots in Settings → Saved versions;
  sync never creates conflict notebooks or pages. The accepted server snapshot
  wins an old operation; newer pending edits remain queued. See
  [conflict prevention and legacy cleanup](docs/NOTEBOOK_CONFLICT_FIX.md).
- The server can read note contents. This release does not implement
  end-to-end encryption or an email-based password-recovery service.
- Drawing pressure falls back to a constant value when the device/browser
  does not supply it. Hardware stylus latency must be tested on real devices.

## Decisions after the initial plan

The user requested code written by **gpt-5.6-luna at max reasoning**, with
integration and verification coordinated in the main task.

The initial plan proposed native iPadOS/PencilKit. The user has no Mac or
Apple Developer membership and explicitly accepted a web app instead, so the
delivered app is one PWA for both devices, keeping one editor to maintain.
Native Android/iPad scaffolding was removed after that decision.
Google login was an initial proposal; the first server uses
identifier/password login so it can run without OAuth-provider provisioning.
The user explicitly approved making this repository public for free GitHub
Pages hosting. Personal notes and credentials do not belong in this repo.

## Verification

ดู [ผลตรวจฟีเจอร์สองรอบและ edge cases วันที่ 12 กันยายน 2026](docs/FEATURE_AUDIT_2026-09-12.md)
เพิ่ม Move / reorder page, กระโดดไปเลขหน้า, ผลค้นหาเปิดตรงหน้า, Restore as copy,
backup เฉพาะสมุด, ส่งออกข้อความเต็ม และจำมุมมองคลัง พร้อม regression tests สำหรับความทนทานของข้อมูล

GitHub Actions records build/test outcomes. The task's final delivery report
states which checks actually passed and which require the user's hardware.
An emulator or automated browser test cannot certify S Pen/Apple Pencil
pressure, palm rejection or perceived writing latency on the physical devices.
