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
โหมด local ใช้จดได้โดยไม่ต้องมีเซิร์ฟเวอร์ หากใช้ backend ทดสอบบนพีซี sync จะหยุดเมื่อพีซีหรือ tunnel ปิด
ไม่มีการซื้อ hosting หรือ Apple Developer Program สำหรับโครงการนี้

เปิดแอปแล้วจะพบหน้า Documents เพื่อเลือกสมุดก่อนเข้าเขียน สร้างสมุดผ่าน New → Notebook → เลือกกระดาษ/ตั้งชื่อ → Create
กดปกเพื่อเปิดสมุด และกด Documents ในหน้าจอเขียนเพื่อกลับคลัง มีค้นหา เรียงลำดับ มุมมองรายการ และ Favorites (บันทึกเฉพาะอุปกรณ์นี้)
หน้าจอเขียนเปิดเต็มพื้นที่โดยซ่อนรายชื่อหน้าและแผงข้อความไว้ก่อน กดชื่อสมุดด้านบนเพื่อเปลี่ยนชื่อ
กดชื่อหน้าเพื่อเปิดรายละเอียดหน้า ใช้นิ้วสองนิ้วซูมและหนึ่งนิ้วเลื่อนกระดาษ
แถบเขียนมีปากกา Fountain/Ball, ไฮไลต์, ยางลบทั้งเส้น, เส้นตรง และโหมดอ่าน/เลื่อน
สีและความหนาจำแยกตามเครื่องมือ ปุ่มลูกศรเปลี่ยนหน้า และปุ่ม ＋ เพิ่มหน้าด้วยกระดาษแบบเดิม
เปิด Text เพื่อทำสำเนาหน้าพร้อมลายเส้นและข้อความ ดู [ผลวิจัย GoodNotes 5 และขอบเขตที่ทำแล้ว](docs/GOODNOTES5-RESEARCH.md)
เมื่อเข้าสู่ระบบ แอปส่งข้อมูลหลังบันทึกและดึงข้อมูลเมื่อกลับมาเปิดแอป/กลับมาออนไลน์
รวมถึงตรวจเป็นระยะระหว่างใช้งาน สถานะบันทึกในเครื่องยังไม่ใช่การยืนยันว่าส่งถึงเครื่องอื่นแล้ว

## Project layout

| Directory | Responsibility |
| --- | --- |
| `webApp/` | Installable web app, browser ink and local SQLite |
| `shared/` | Kotlin JSON models shared with the server's tests |
| `server/` | Authentication and SQLite revision-sync API |
| `docs/CONTRACT.md` | Shared JSON format and API contract |
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

See [server deployment](server/README.md) and [temporary testing](docs/TESTING.md) for persistent storage, TLS, origin
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
- Concurrent changes preserve recoverable copies instead of silently
  overwriting handwriting. Sync is not live collaborative editing.
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

GitHub Actions records build/test outcomes. The task's final delivery report
states which checks actually passed and which require the user's hardware.
An emulator or automated browser test cannot certify S Pen/Apple Pencil
pressure, palm rejection or perceived writing latency on the physical devices.
