# ตรวจฟีเจอร์และ edge cases — 12 กันยายน 2026

ขอบเขต: ตรวจ repository สองรอบก่อนเริ่มแก้โค้ด แล้วเพิ่มฟีเจอร์ที่ใช้ได้กับโมเดลข้อมูลและระบบ sync เดิม พร้อมแก้ความเสี่ยงต่อข้อมูล ทดสอบด้วยข้อมูลจำลองในฐานข้อมูล SQLite และ browser context ใหม่ ไม่ใช้ฐานข้อมูลสมุดจริง

สถานะ: แก้ใน workspace, build `2026.09.12.1` ยังไม่ push หรือ deploy

## การตรวจสองรอบก่อนลงมือ

### รอบ 1 — ความสามารถและเส้นทางใช้งาน

อ่าน README, เอกสารการซ่อมและ checklist เดิม, โครงสร้างแอป, model, ตัวจัดเก็บ SQLite/worker, หน้าคลัง/หน้าเขียน, canvas, media import/export, sync client/coordinator รวมถึงเส้นทาง validation ของ Cloudflare และ Kotlin server

ตรวจเส้นทาง: สร้างสมุด → เพิ่ม/แก้หน้า → บันทึก → sync → ค้นหา → ทำสำเนา → ทิ้ง/กู้คืน → export/import

ข้อค้นพบสำคัญ:

- มี `order` ในข้อมูลหน้าและส่งผ่าน sync อยู่แล้ว แต่ไม่มี UI ย้าย/จัดลำดับหน้า
- ค้นหาเนื้อหาในสมุดได้ แต่ผลค้นหาในคลังเปิดได้เพียงสมุด ไม่แสดงหน้าที่ตรงคำค้น
- มี Saved versions แต่ต้อง export แล้ว import เองจึงจะกู้กลับมาใช้ได้
- มี export ทั้งคลังและ PDF/PNG แต่ไม่มี backup เฉพาะสมุดหรือ export ข้อความทั้งหมด
- มีปุ่มเปลี่ยนหน้าติดกัน แต่ไม่มีการกระโดดไปเลขหน้า
- การตั้งเรียงสมุดและมุมมองรายการไม่จำเมื่อ reload

### รอบ 2 — สถานะผิดปกติและความทนทาน

ตามการเรียกฟังก์ชันจาก UI ผ่าน storage worker, transaction และ outbox ตรวจ asynchronous boundaries และเปรียบเทียบกับ regression tests เดิม

ตรวจกรณี: ชื่อถึงขีดจำกัด, เขียนข้อมูลไม่สำเร็จกลางชุด, parent ถูกลบ, ส่ง operation เดิมซ้ำ, คิว pending/sending, เปลี่ยนบัญชีระหว่างอ่านไฟล์, cancel ระหว่าง export, จำนวนจุดปากกาเต็ม, order เกิน safe integer และข้อความที่แสดงไม่หมดบนกระดาษ

ก่อนแก้โค้ด ชุดทดสอบเว็บเดิมผ่าน 140 ข้อ หลังจากนั้นชุด Cloudflare เดิมผ่าน 11 ข้อ ผลผ่านเดิมไม่ได้ครอบคลุมความเสี่ยงทุกข้อด้านล่าง

## ฟีเจอร์ที่เพิ่มแล้ว

| ฟีเจอร์ | วิธีใช้และพฤติกรรม |
| --- | --- |
| จัดลำดับหน้า | เมนู ⋯ ของหน้า → Move / reorder page → เลือกตำแหน่งก่อนหน้าใดหรือท้ายสมุด เก็บลำดับในข้อมูลที่ sync |
| ย้ายหน้าข้ามสมุด | เมนูเดียวกัน → เลือกสมุดปลายทาง เก็บ ID หน้าเดิม ลายเส้น รูป และข้อความไปด้วยกัน |
| กระโดดไปเลขหน้า | แตะตัวเลข `1 / 20` → กรอกเลขหน้า รองรับคีย์บอร์ดและตรวจจำนวนเต็ม/ขอบเขต |
| เปิดผลค้นหาตรงหน้า | ค้นหาใน Documents → Matching pages → แตะหน้าที่ตรงผลลัพธ์ แสดงชื่อสมุดและตัวอย่างข้อความ |
| ค้นหาข้อความข้ามบรรทัดและ Unicode | รวมช่องว่าง/ขึ้นบรรทัดใหม่ และ normalize NFC ทำให้ `Café` กับ `Cafe + combining accent` ค้นเจอกัน |
| กู้ Saved version โดยตรง | Settings → Saved versions → Restore as copy สร้างสมุดใหม่ เก็บเวอร์ชันเก่าและโน้ตปัจจุบันไว้ |
| Backup เฉพาะสมุด | เมนู ⋯ ของสมุดใน editor → Export this notebook backup รวมหน้าที่อยู่ในถังขยะและ saved versions ที่ผูกกับสมุดนั้น |
| ส่งออกข้อความเต็ม | เมนู ⋯ ของหน้า → Export full typed text (.txt) เก็บ Unicode และทุกบรรทัด รวมส่วนที่เลยขอบกระดาษ |
| จำมุมมองคลัง | จำ Sort by และ List view แยกตามบัญชี/endpoint บนอุปกรณ์นี้ การเขียน preferences ล้มเหลวไม่ทำให้บันทึกโน้ตล้มเหลว |

## Edge cases ที่แก้แล้ว

| กรณีและปัญหาเดิม | การแก้และขอบเขต |
| --- | --- |
| ชื่อ 500 ตัวอักษร → Duplicate เติม `(copy)` แล้วเกิน schema | สำรองพื้นที่ให้ suffix ทั้งสำเนาหน้าและสมุด ไม่ตัดครึ่ง surrogate pair ของ emoji |
| สร้างสมุดสำเร็จแต่หน้าแรกเขียนไม่สำเร็จ | ใช้ transaction ของ importDocument สำหรับสมุดกับหน้าแรก ไม่มีสมุดครึ่งชุดจาก SQL failure |
| Duplicate สมุดล้มเหลวที่หน้ากลาง ๆ | ย้ายงานทั้งชุดไป transaction เดียวใน storage รวม outbox; SQL failure rollback ทุกหน้า |
| Duplicate สมุดว่าง | สร้างสำเนาสมุดว่างได้ ไม่บังคับว่าต้องมีหน้าเหมือน media import |
| Duplicate สมุดมีมากกว่า 100 หน้า | คำสั่ง duplicate ไม่ใช้ขีดจำกัด 100 หน้าของ media import; ยังขึ้นกับพื้นที่และทรัพยากรเครื่อง |
| กด Duplicate notebook รัว ๆ ระหว่างทำงาน | กั้นการทำงานซ้อนใน UI ให้มีงานเดียวต่อช่วงที่กำลังทำสำเนา |
| กู้หน้าในสมุดที่ยังอยู่ในถังขยะ | storage ตรวจ parent ใน transaction และแจ้ง Restore the notebook first ไม่มี operation ที่เซิร์ฟเวอร์จะปฏิเสธถูกเพิ่ม |
| ย้ายหน้าที่ลบ/หน้า recovery/จากสมุดที่ลบ | ปฏิเสธก่อนเขียนข้อมูล ให้ restore ก่อน |
| ปลายทางถูกลบหลังเปิดหน้าต่างย้าย | ตรวจสถานะสมุดปลายทางอีกครั้งใน transaction |
| ตำแหน่งติดลบ ทศนิยม NaN Infinity หรือเกินจำนวนหน้า | ตรวจที่ storage แม้ข้าม native form validation มาก็เขียนไม่ได้ |
| UUID ตัวพิมพ์ใหญ่ในคำสั่งย้าย | canonicalize ก่อนอ่าน row ให้ตรงกับ ID ที่จัดเก็บ |
| หน้าเก่าไม่มี order หรือมี order ซ้ำ | ใช้ลำดับ fallback เดิมเป็นฐาน แล้วกำหนดลำดับใหม่ต่อเนื่องให้หน้าปลายทาง |
| ย้ายหน้า pending ไปสมุดที่เพิ่งสร้าง | ย้าย operation ที่ยังไม่ส่งไปท้ายคิว ให้สมุดปลายทางถูกสร้างก่อนหน้า ไม่แก้ op ที่เป็น sending |
| หน้ากำลังส่งอยู่ระหว่างย้าย | คง payload/opId ของ sending เดิม แล้วสร้าง pending สำหรับตำแหน่งใหม่ |
| editor เก่าบันทึกหลังหน้าย้ายสมุดแล้ว | ปฏิเสธการ save ที่พยายามย้อน notebookId และแจ้งให้เปิดหน้าใหม่ |
| order ถึง Number.MAX_SAFE_INTEGER | แจ้งให้ reorder ก่อนเพิ่มหน้า ไม่สร้างตัวเลขที่ JavaScript แทนค่าไม่ได้ การ reorder กู้ให้เพิ่มหน้าต่อได้ |
| import เตรียมลำดับไว้แล้วมีหน้าอื่นเข้ามาก่อน commit | คำนวณตำแหน่ง append จากข้อมูลล่าสุดใน transaction |
| อ่านไฟล์ backup ค้างแล้ว logout/เปลี่ยน workspace | จับ store เดิมและตรวจ session/store หลัง await ก่อน import; ผลจากงานเก่าไม่เข้าบัญชีใหม่ |
| import backup ซ้อนกัน | กั้นงาน import ซ้อน และล้าง file input ตั้งแต่รับ event เพื่อเลือกไฟล์เดิมอีกครั้งได้ |
| export backup หรืออ่านข้อมูลล้มเหลว | จับ error และแสดงสถานะ ไม่ปล่อย unhandled rejection ในเส้นทาง export/share |
| กดยกเลิก native Share | AbortError จบงานทันที ไม่ดาวน์โหลดไฟล์เองหลังผู้ใช้ยกเลิก |
| cancel PNG ระหว่างรอ renderer/encoder | ตรวจ AbortSignal หลัง await และคืนพื้นที่ canvas เสมอ |
| ส่งหลายหน้าเข้า PNG exporter | แจ้งให้ใช้ PDF แทนการส่งเฉพาะหน้าแรกอย่างเงียบ ๆ |
| cancel PDF ระหว่าง final serialization | ตรวจ AbortSignal อีกครั้งหลัง pdf.save ก่อนคืนไฟล์ |
| พิมพ์ชื่อ/ข้อความเกิน schema จากช่องกรอก | เพิ่ม maxlength 500 / 1,000,000 ให้ตรง storage; paste บนกระดาษยังตรวจขนาดก่อนเพิ่ม |
| คีย์จาก IME ตรงกับปุ่มลัดเครื่องมือ | ข้าม shortcut ขณะ composition รวม legacy keyCode 229 |
| ซ่อนแอปก่อน debounce save | เรียก flush เมื่อ visibility hidden เพิ่มจาก pagehide; การปิดหน้าขณะมีงานค้างใช้ beforeunload prompt ของ browser |
| วาดเกิน 10,000 เส้น/200,000 จุดจนทั้งหน้าบันทึกไม่ได้ | ป้องกันการเกินก่อนเพิ่มเส้น/ตัวอย่างจุด แจ้งบน editor เก็บจุดที่รับไว้แล้ว และยังลบหมึกเพื่อเขียนต่อได้ |
| driver ส่ง tilt เกิน -90 ถึง 90 | clamp ก่อนเก็บ ป้องกัน schema ปฏิเสธทั้งหน้าเพราะค่าปากกาผิดช่วง |
| backup import สร้าง ID ใหม่แต่ saved versions ยังผูก ID เก่า | remap ID และ notebookId ของเวอร์ชันที่มี entity อยู่ใน archive ทำให้ export เฉพาะสมุดยังพา history ไปด้วย |
| ข้อมูลถูกต้องตาม schema แต่ sanitizer เปลี่ยนขนาดเอง | เก็บหน้าเล็กกว่า 320, รูปขนาดเศษส่วนต่ำกว่า 1 และเส้นบาง 0.1 ตามเดิม ไม่ขยายเองระหว่าง backup/sync |
| ค้นหาไม่เจอแล้วข้อความบอกว่าไม่มีหน้า | แสดง No matching pages เพื่อแยกผลค้นหาว่างจากสมุดว่าง |
| รายการหน้าจำนวนมากใช้ indexOf ในทุกแถว | ใช้ index จาก map ลดงานค้นหาซ้ำในลูป |

## รายการที่ควรพัฒนาต่อ

รายการนี้เป็นข้อเสนอจากการตรวจ ไม่ได้อ้างว่าทำแล้ว ความสำคัญเรียงจากการดูแลข้อมูลและการใช้งานหลักก่อนฟีเจอร์ขั้นสูง

| ลำดับ | ฟีเจอร์/ข้อจำกัดที่เหลือ | สิ่งที่ต้องตัดสินใจหรือทดสอบก่อนทำเต็มรูปแบบ |
| --- | --- | --- |
| 1 | Backup ขนาดเกิน 50 MiB ยัง import กลับไม่ได้ในไฟล์เดียว | รูปแบบ archive แบบหลายส่วนหรือ streaming พร้อม checksum; ตอนนี้ยัง export ไฟล์เต็มได้เพื่อเก็บสำเนา และเลือก export เฉพาะสมุดได้ |
| 2 | Undo/redo สำหรับรูป ข้อความ และการจัดหน้า | history เดิมเป็นลายเส้น ต้องกำหนดอายุ history/การชนกับ remote updates ก่อนรวมทุกชนิด |
| 3 | แบ่ง typed note ยาวเป็นหลายหน้า | การแสดงข้อความบนกระดาษกับ PDF ยังตัดตามพื้นที่หน้า ฟีเจอร์ .txt ใหม่ช่วยส่งออกส่วนที่เกินได้ครบ |
| 4 | เปรียบเทียบ Saved versions ก่อนกู้ | แสดงภาพย่อ/ข้อความ diff และเลือกตำแหน่งกู้ในสมุดเดิม |
| 5 | จำกัดการสะสม Saved versions | retention ต้องรักษาเวอร์ชันที่ยังไม่ได้ backup ไม่ควรลบอัตโนมัติโดยไม่มีนโยบายชัดเจน |
| 6 | ซ่อมคิว sync รายรายการ | แสดง operation ที่ rejected/ใหญ่เกิน พร้อมเหตุผลและทางแก้ที่เข้าใจง่าย |
| 7 | แสดงพื้นที่ใช้/พื้นที่ว่าง และขอ persistent storage | ต้องรองรับ browser ที่ไม่มี Storage API และแยกข้อมูลประมาณการกับพื้นที่จริง |
| 8 | เลือกหลายหน้าเพื่อย้าย/สำเนา/ส่งออก | transaction กับ undo ต้องรองรับ partial failure และ stale selection |
| 9 | Bookmark หน้า | ปัจจุบัน Favorites เป็นสมุดและอยู่เฉพาะอุปกรณ์ ต้องกำหนดว่าจะ sync bookmark หรือไม่ |
| 10 | โฟลเดอร์และแท็ก | ต้องขยาย schema/สัญญา server ทั้ง Cloudflare และ Kotlin รวม migration |
| 11 | Search แบบจำกัดสมุดและ highlight คำที่ตรง | ผลค้นหาหน้าใหม่แสดงสูงสุด 200 รายการเพื่อคุม DOM; ยังไม่มี pagination/index |
| 12 | Full-text index สำหรับคลังขนาดใหญ่ | ปัจจุบันอ่านหน้าทั้งคลังเพื่อค้นหา ต้องวัดกับสมุดที่มีรูปหลายพันหน้าก่อนเลือก index |
| 13 | Lasso เลือก/ย้าย/ย่อขยายลายเส้น | ต้องรักษา pressure/time, undo และขอบเขตการเลือกเมื่อหมุน/ซูม |
| 14 | ลบเฉพาะส่วนของเส้น | eraser ปัจจุบันลบทั้ง stroke ต้องนิยามการแบ่งเส้นและ ID ใหม่อย่างสอดคล้องกับ undo |
| 15 | กล่องข้อความอิสระ | ต้องเพิ่มตำแหน่ง ขนาด รูปแบบตัวอักษร และการ render/export ให้เหมือนกัน |
| 16 | รูปทรง วงกลม ลูกศร และ snap | ตอนนี้มีเส้นตรง การเพิ่มรูปทรงต้องมีการแก้และ export หลังสร้าง |
| 17 | หมุน/ครอปรูปและล็อกรูปพื้นหลัง | ต้องรักษาต้นฉบับหรือเลือกการแก้ถาวร รวมแนวทาง undo |
| 18 | PDF ที่มี text layer/ลิงก์/ฟอร์ม | ปัจจุบัน rasterize เป็นภาพ จึงค้นจากข้อความภายใน PDF หรือติ๊กฟอร์มเดิมไม่ได้ |
| 19 | นำเข้า PDF ที่ใส่รหัสผ่าน | ต้องมี dialog รับรหัสแบบชั่วคราวและรองรับ cancel ระหว่าง worker ถอดรหัส |
| 20 | OCR ไทย/อังกฤษและค้นลายมือ | ต้องตัดสินใจประมวลผลในเครื่องหรือบริการภายนอก ความแม่นยำและความเป็นส่วนตัวต่างกัน |
| 21 | รีเซ็ตรหัสผ่าน/เปลี่ยนรหัสผ่าน/จัดการ session | ต้องเพิ่ม API และโครงสร้างยืนยันตัวตน ปัจจุบันยังไม่มี email delivery service |
| 22 | ซิงก์ Favorites และ settings ข้ามอุปกรณ์ | ปัจจุบันบันทึกแยกบัญชีเฉพาะเครื่อง ต้องเพิ่ม model/revision สำหรับ preferences |
| 23 | End-to-end encryption | ต้องออกแบบกุญแจ การกู้บัญชี การค้นหา และการย้ายเครื่อง ปัจจุบัน server อ่านเนื้อหาได้ |
| 24 | Shared notebook/ร่วมแก้เอกสาร | ต้องมีสิทธิ์ access, revoke, invitation และการรวมการแก้ระดับเนื้อหา มากกว่า snapshot conflict เดิม |
| 25 | การเข้าถึง canvas ด้วย screen reader | UI ใหม่ใช้ปุ่ม/label/native form แต่เนื้อหาลายมือยังต้องมีคำอธิบายหรือข้อความทดแทน |

## การตรวจรับ

| การตรวจ | ผล |
| --- | --- |
| เว็บก่อนแก้ | 140 tests ผ่าน |
| เว็บหลังแก้ | 162 tests ผ่าน ใน 18 ไฟล์ เพิ่ม 22 regression cases |
| Cloudflare Worker/D1 | 11 tests เดิมผ่าน; ไม่เปลี่ยน backend API |
| TypeScript + production build | ผ่าน |
| Edge: editor smoke เดิม | ผ่าน PDF/ภาพ/clipboard/ปากกา/เมนู/export/reload |
| Edge: feature-audit ใหม่ | ผ่าน search Unicode, move, reorder, jump, export .txt/สมุด, duplicate, restore version, preferences, จอ 390px, cancel share, logout ระหว่างอ่าน backup |
| Edge: feature-audit บน production preview | ผ่าน |
| Edge: editor smoke บน production preview แบบ offline | ผ่าน; ใช้ service worker ของ build จริง |
| Kotlin server | ไม่ได้รันรอบนี้; ไม่มี java ใน PATH และไม่ได้แก้ Kotlin |

ทดสอบ transaction กับ Node SQLite จริง ไม่ใช่เพียง mock ผลลัพธ์: มี trigger จำลอง Disk full ตอนสร้างหน้าและตอน reorder เพื่อตรวจ rollback ของข้อมูลและ outbox รวมถึงการรักษา sending operation เดิม

Browser QA ใช้ endpoint `qa.invalid`, browser context ใหม่ และ fixture ในสคริปต์ ไม่อ่านข้อมูลบัญชีจริง ภาพอยู่ใน `webApp/test-results/feature-audit/` และ `webApp/test-results/editor/` ซึ่งไม่เข้า Git

### คำสั่งตรวจซ้ำ

จากโฟลเดอร์ `webApp`:

```powershell
npm test
npm run build
$env:QA_BROWSER_CHANNEL='msedge'
npm run test:features
npm run test:browser
```

ตรวจ production ด้วย `npm run preview -- --port 4182 --strictPort` แล้วตั้ง:

```powershell
$env:QA_URL='http://127.0.0.1:4182/native-notes/'
npm run test:features
$env:QA_OFFLINE='1'
npm run test:browser
```

## ข้อจำกัดที่ยังต้องทดสอบบนอุปกรณ์จริง

- Browser test ไม่ยืนยันความหน่วง ความรู้สึกเขียน pressure หรือ palm rejection บน Apple Pencil/S Pen จริง
- ต้องทดสอบการย้ายหน้าและ reorder ระหว่างสองอุปกรณ์ที่แก้พร้อมกันกับ production server นโยบายเดิมยังเป็น revision snapshots ไม่ได้ทำ collaborative merge
- การย้ายหลายแถวเป็น atomic เฉพาะฐานข้อมูล local; เซิร์ฟเวอร์และอีกเครื่องอาจเห็นลำดับระหว่างทางในแต่ละ sync batch ได้
- เมื่อ local persistence ของ IndexedDB ล้มเหลวหลัง SQL COMMIT ระบบเดิมจะบล็อกการเขียนต่อและให้ reload ไม่รับรอง rollback ของหน่วยความจำ ณ จุดนั้น
- visibility/pagehide/beforeunload ช่วยลดความเสี่ยง แต่ browser หรือระบบปฏิบัติการที่ kill process ทันทีไม่รับประกันว่าจะรัน asynchronous save จบ
- limit ปากกาเก็บจุดที่รับมาได้ถึงเพดาน แล้วต้องเขียนหน้าถัดไป ไม่ได้บีบ/ลดจำนวนจุดเดิมอย่างเงียบ ๆ
- Saved notebook version มีเฉพาะ metadata ของสมุด; การกู้เนื้อหาหน้าต้องเลือก page version นั้น ๆ
