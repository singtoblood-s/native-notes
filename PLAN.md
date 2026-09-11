# แผนแอปจดโน้ต Android + iPadOS

สถานะ: ร่างแผนก่อนลงมือพัฒนา — ยังไม่มีโค้ดแอปหรือการ deploy
วันที่ตรวจเอกสาร: 11 กันยายน 2026
อุปกรณ์เป้าหมาย: Samsung Galaxy S25 Ultra และ iPad Pro M1 11 นิ้ว ปี 2021

## 1. ข้อเสนอหลัก

ใช้ native UI และ native ink ของแต่ละระบบ โดยแชร์เฉพาะข้อมูล ฐานข้อมูล และ sync ผ่าน Kotlin Multiplatform (KMP)
แอปอ่านและเขียน SQLite ในเครื่องได้โดยไม่รออินเทอร์เน็ต ส่วน login ใช้เพื่อเข้าถึงบัญชีและ sync
เก็บโค้ดใน GitHub monorepo ใช้ GitHub Actions ตรวจสอบและ build และวาง backend บนเครื่องที่มี persistent disk แยกต่างหาก

ข้อเสนอนี้ให้ความสำคัญกับความลื่นของปากกาและความปลอดภัยของโน้ต แต่ยังต้องดูแล UI สองชุด รวมถึง Gradle และ Xcode
ไม่รับประกันว่าใช้ KMP แล้วจะเบาหรือเร็วโดยอัตโนมัติ ต้องวัดจาก release build บนอุปกรณ์จริง

### เทคโนโลยีที่เสนอ

| ส่วน | เทคโนโลยี | เหตุผล / ข้อแลกเปลี่ยน |
| --- | --- | --- |
| Android | Kotlin + Jetpack Compose + AndroidX Ink stable | ใช้ระบบรับปากกาและแสดงหมึกที่ออกแบบสำหรับ Android |
| iPadOS | SwiftUI + UIKit/PKCanvasView (PencilKit) | เข้าถึง Apple Pencil และพฤติกรรม native โดยตรง |
| Shared core | Kotlin Multiplatform | แชร์แบบข้อมูล การบันทึก และกติกา sync เพื่อลดความต่างระหว่างสองเครื่อง |
| SQLite ในเครื่อง | SQLDelight | schema และ query อยู่ใน SQL ที่ตรวจสอบและแชร์ได้ |
| Network | Ktor Client | ใช้ร่วมใน shared core ส่งข้อมูลนอกเส้นทางรับปากกา |
| Backend | Ktor/JVM หนึ่ง service + SQLite | ใช้ Kotlin ต่อเนื่อง ลดจำนวนภาษา แต่ JVM มีต้นทุน RAM ซึ่งต้องวัด |
| Login | ผู้ให้บริการ OIDC ที่มี SDK รองรับ; เสนอ Google สำหรับรุ่นแรก | ไม่ต้องดูแลรหัสผ่านและระบบ reset password เอง; ตัวเลือกยังรอยืนยัน |
| Hosting | GitHub สำหรับ source/CI; backend บน persistent host | GitHub Pages ให้บริการไฟล์ static จึงไม่รัน API/SQLite server |

ยังไม่เพิ่ม microservices, Redis, Kubernetes, realtime collaboration หรือ dependency สำหรับอนาคต
Flutter/React Native เป็นทางเลือกได้ แต่ส่วนปากกายังต้องประเมินและเชื่อม native อยู่ดี จึงไม่ใช่ตัวเลือกแรกของข้อเสนอนี้
การเลือกนี้เป็นข้อเสนอทางวิศวกรรมตามโจทย์ ไม่ใช่ผล benchmark เปรียบเทียบ framework

## 2. ข้อกำหนดที่ยืนยันแล้วและสมมติฐาน

ยืนยันแล้วจากผู้ใช้:

- ใช้ GitHub เก็บโค้ด/build และมี backend แยกได้
- iPad Pro M1 11 นิ้ว ปี 2021 และไม่มี Mac; ผู้ใช้จะทดสอบบนอุปกรณ์จริงด้วยตนเองหลังได้รับลิงก์
- รุ่นแรกจดด้วยปากกาและข้อความ พร้อม sync สองเครื่อง; ยังไม่รวม PDF import

ยังต้องยืนยัน/สมมติฐานในการออกแบบ:

- ใช้ส่วนตัว หนึ่งบัญชีบนสองอุปกรณ์ และต้องการ sync โน้ตที่ยังแก้ไขเส้นหมึกต่อได้
- ยังไม่เลือกผู้ให้บริการและงบ hosting; การยอมรับ backend แยกไม่ใช่การอนุมัติซื้อบริการ
- รุ่น Apple Pencil และเวอร์ชัน OS ยังไม่ทราบ; ปี 2021 และขนาด 11 นิ้วระบุรุ่น iPad ไม่ยืนยันรุ่นปากกา
- ยังไม่ทราบการเข้าถึง Apple Developer Program/signing สำหรับ build ที่ติดตั้งได้
- Google login เป็นข้อเสนอเริ่มต้น ไม่ใช่ข้อกำหนดที่ผู้ใช้ยืนยันแล้ว
- ยังไม่กำหนด E2EE; หากต้องการให้ผู้ดูแล server อ่านโน้ตไม่ได้ ต้องออกแบบการเข้ารหัสและกู้คืนกุญแจก่อนทำ sync

## 3. ความสามารถตามฮาร์ดแวร์

- S25 Ultra: รองรับการเขียนผ่าน stylus APIs; ประเมิน pressure, tilt, hover, palm rejection และปุ่มปากกาจริงบนเครื่อง
- S Pen รุ่นนี้ไม่มี BLE/Air Actions จึงไม่ตั้งเป้าคำสั่งจากการโบกปากกาหรือกดรีโมต
- iPad Pro M1 ใช้ Apple Pencil รุ่น 2 หรือ USB-C ตามรายการอุปกรณ์ที่รองรับ; ต้องทราบรุ่นจริงก่อนกำหนด interaction
- Apple Pencil USB-C ไม่มี pressure sensitivity และ double-tap จึงต้องมีความหนาปากกาคงที่และปุ่มบนจอเป็นทางเลือก
- ไม่ตั้งข้อกำหนด Pencil Pro squeeze/barrel roll หรือ Apple Pencil hover ให้ iPad M1
- Shortcut ระบบ, เปิดจาก lock screen, screen-off memo และ handwriting-to-text ต้องตรวจ API/สิทธิ์/ภาษาแยกกัน ไม่ถือว่าแอป third-party ทำได้เท่าแอประบบทั้งหมด
- การทดสอบ build ฝั่ง iPad ต้องใช้ macOS/Xcode; macOS CI ช่วย build ได้ แต่ไม่แทนการทดสอบ Apple Pencil จริง และยังต้องจัดการ signing/distribution

## 4. ขอบเขตรุ่นแรกที่เสนอ

1. สมุด → โน้ต → หน้ากระดาษขนาดคงที่ พร้อมพื้นหลังเปล่า เส้นบรรทัด และตาราง
2. ปากกาที่ปรับสี/ขนาดได้ และ pressure เมื่อฮาร์ดแวร์รองรับ; highlighter เข้ารุ่นแรกเมื่อผ่านการแปลงข้ามเครื่อง
3. ยางลบทั้งเส้น, undo/redo ในเครื่อง, zoom/pan, ป้องกันฝ่ามือ และโหมดใช้นิ้วเลื่อนหน้า
4. กล่องข้อความพื้นฐาน รองรับคีย์บอร์ดไทย/อังกฤษ; ค้นหาชื่อและข้อความที่พิมพ์
5. Autosave ลง SQLite, เปิดอ่าน/เขียน offline, login และ sync สองอุปกรณ์
6. สถานะที่แยกชัดเจน: กำลังบันทึก / บันทึกในเครื่องแล้ว / รอ sync / sync แล้ว / ต้องแก้ conflict
7. ถังขยะ, ส่งออก PDF/ภาพเพื่ออ่าน และ archive ที่นำกลับมาแก้ไขได้

เลื่อนออกจากรุ่นแรก: infinite canvas, ลบหมึกบางส่วน, rich text เต็มรูปแบบ, OCR/ค้นหาลายมือ, AI, อัดเสียง และแชร์แก้ไขพร้อมกัน
Lasso/ย้าย/ย่อขยายหมึกเพิ่มหลังการทดสอบ stroke identity และ transform ไปกลับผ่าน
หาก PDF เป็นงานหลัก ต้องเพิ่มการนำเข้า PDF ในขอบเขตตั้งแต่ต้น: PDF เป็นพื้นหลัง immutable และหมึกเป็น annotation แยกชั้น

## 5. ความเสี่ยงอันดับหนึ่ง: รูปแบบหมึกข้ามระบบ

ไฟล์ PKDrawing ใช้เป็นรูปแบบกลางที่ Android แก้ไขได้โดยตรงไม่ได้ และไม่ควรสมมติว่าหมึกจากสอง renderer หน้าตาเหมือนกัน
ต้องทำ technical spike ก่อนสร้างระบบอื่นจำนวนมาก

รูปแบบกลางแบบมี version เก็บอย่างน้อย:

- stroke ID, ลำดับซ้อน, brush ID/version, สี/opacity และขนาด
- จุดในพิกัดหน้ากระดาษ, เวลาแบบ relative, pressure ที่ normalize พร้อมค่า unknown, มุมเอียงและทิศทางพร้อมหน่วยชัดเจน
- transform และ bounds; เก็บข้อมูล path/ขนาดรายจุดที่จำเป็นต่อ PencilKit โดยไม่ลดทิ้งอย่างเงียบ ๆ
- ห้ามเก็บ predicted points เป็นข้อมูลจริง และต้องรวม estimated-property updates ที่ระบบส่งตามหลังตาม API ที่ใช้

รูปแบบกลางเป็นแหล่งข้อมูลสำหรับการแลกเปลี่ยน; native drawing/cache ผูกกับ revision และต้อง invalidate เมื่อข้อมูลเปลี่ยน
เก็บต้นฉบับ native ของ revision ต้นทางเพื่อการกู้คืนตามความเหมาะสม แต่ไม่ใช้ cache เก่าเขียนทับ revision ใหม่
การเปิดแล้วบันทึกโดยไม่แก้ไขต้องไม่ทำให้ข้อมูลกลางถูก resample ซ้ำจนเส้นเพี้ยน

การผ่าน spike ต้องแสดงว่าเขียนบน S25 → เปิด/เพิ่ม/ลบบน iPad → กลับ S25 และสลับทิศทางได้
ทดสอบ pressure, tilt, จุดเดี่ยว, เส้นยาว, การซ้อนสี, zoom, undo และการลบทั้งเส้นโดยไม่มีเส้นหายหรือย้ายตำแหน่ง
กำหนด stroke identity ที่คงที่เมื่อ PencilKit คืน drawing ใหม่ และควบคุมเครื่องมือให้ตรงขอบเขตที่แปลงได้
เริ่มจากปากกาชุดเล็กที่สองระบบทำได้ตรงกัน หากแปลงแล้วผิดมาก ให้ตัดสินใจเรื่องรูปแบบ/renderer ใหม่ก่อนทำผลิตภัณฑ์เต็ม
หากต้องการ pixel-identical rendering ต้องประเมิน renderer ร่วมเพิ่ม; ไม่รับประกันจากการใช้ native engine สองตัว

ณ วันที่ตรวจ AndroidX Ink stable คือ 1.0.0; iOS Metal rendering ใน 1.1.0-alpha08 ยัง experimental จึงไม่ใช้เป็นฐานหลักในแผนนี้

## 6. SQLite และ sync ที่ป้องกันข้อมูลหาย

แต่ละอุปกรณ์มี SQLite ของตนเอง; server มี SQLite อีกชุดหนึ่ง ไม่คัดลอกไฟล์ .db ที่ใช้งานอยู่ไปทับกันผ่าน Git/cloud drive
ใช้ foreign keys, transaction, migration แบบ versioned และงาน I/O นอก main thread
ใช้ WAL ตาม driver ที่รองรับ โดยตรวจ durability settings และ checkpoint ผ่านการทดสอบ ไม่ถือว่า WAL แทน backup

หน่วยข้อมูลเริ่มต้น: notebooks, notes, pages, page_revisions, outbox และ sync_state; server เพิ่ม users/identities/sessions
revision ของหน้ามี snapshot ที่บีบอัดของหมึก/ข้อความ; เมื่อมีไฟล์แนบเก็บเป็นไฟล์ที่อ้างด้วย ID/hash ไม่ใส่ Base64 ใน JSON
โหลดและ sync เฉพาะหน้าที่เปลี่ยน กำหนดเพดาน payload และ benchmark ก่อนตัดสินใจใช้ snapshot ต่อหน้าในระยะยาว
หาก snapshot ของหน้าหนักเกินเป้าจริง ค่อยเปลี่ยน transport เป็น stroke chunks โดยยังรักษากติกา revision เดิม

### ขั้นตอนบันทึก

1. native canvas แสดงเส้นทันที ไม่รอ network หรือ shared state update ทุกจุด
2. หลังจบเส้น จัดคิว commit revision และ outbox ใน transaction เดียว พร้อมเลขลำดับ local edit
3. แสดงว่าบันทึกแล้วหลัง transaction สำเร็จเท่านั้น; งาน serialize/thumbnail อยู่เบื้องหลังและต้องไม่แซงลำดับ revision
4. worker ส่ง revision ที่เปลี่ยนพร้อม operation ID และ base revision
5. server ตรวจเจ้าของข้อมูลและ base revision แล้ว commit พร้อม server sequence ก่อนตอบสำเร็จ
6. client ทำเครื่องหมาย ack และ pull ด้วย cursor; apply ข้อมูลกับ cursor ใน transaction เดียว

ไม่รับประกันเส้นที่ยังไม่ commit หาก OS kill ทันที; ต้องทดสอบช่วง pen-down, pen-up, commit และการเข้า background แยกกัน
อนุญาต checkpoint ระหว่างเส้นยาวหาก spike พบว่าจำเป็น โดยไม่เพิ่ม I/O ต่อทุก sample

### กติกา conflict รุ่นแรก

- แก้คนละหน้า: รับได้อิสระ
- แก้หน้าเดียวกันจาก base เดียวกัน: server รับด้วย compare-and-swap; ฝั่งแพ้เก็บเป็น conflict copy และให้เลือก/เทียบเอง
- ห้ามใช้เวลาของเครื่องหรือ last-write-wins ทับลายมือโดยไม่แจ้ง
- ย้าย/เปลี่ยนชื่อ/ลบสมุดและโน้ตต้องมี revision check เช่นเดียวกัน
- ลบขณะอีกเครื่องแก้ offline: เก็บการลบเป็น tombstone และเก็บงานแก้เป็นสำเนากู้คืน ไม่ทำให้โน้ตกลับมาเงียบ ๆ
- retry operation ID เดิมต้องได้ผลเดิม ห้ามเกิดข้อมูลซ้ำ; payload เดิมของ request ที่กำลังส่งต้อง immutable
- outbox coalesce ได้เฉพาะงานที่ยังไม่ส่ง และต้องรักษา base ของงานที่อยู่ระหว่างส่ง
- ไม่ล้าง tombstone/dedup history โดยไม่มีนโยบายอุปกรณ์ที่ offline นาน; หาก cursor หมดอายุให้ rebase/full-resync พร้อมรักษา local outbox
- undo ข้ามการรับ remote revision ต้องไม่ย้อนทับการเปลี่ยนของอีกเครื่อง; รุ่นแรก reset history เมื่อเปลี่ยน base และเก็บ revision เดิมให้กู้ได้
- sync เมื่อเปิดแอป/กลับ foreground/เน็ตกลับมา และ debounce ขณะเปิดใช้; background เป็น best effort ตาม OS จึงมีปุ่ม sync เอง

## 7. Login และความเป็นส่วนตัว

- ใช้ official SDK หรือไลบรารี OIDC ที่ดูแลอยู่; native authorization ผ่าน system browser/OS flow ตามผู้ให้บริการ พร้อม PKCE/state/nonce เมื่อ flow กำหนด
- server ตรวจ signature, issuer, audience, expiry และ nonce ตาม flow; ระบุตัวตนด้วย issuer + subject ไม่ใช้ email เป็น ID หลัก
- หลังยืนยันตัวตนออก session ของแอปแบบ revoke ได้; token เก็บใน Keychain/พื้นที่ปลอดภัยที่อาศัย Android Keystore ไม่ฝัง secret ในแอปหรือ repo
- ทุก API รวมไฟล์แนบตรวจ user ownership; server หา user จาก session ไม่เชื่อ user ID ที่ client ส่ง
- session หมดอายุหรือ auth server ล่มต้องยังจดใน workspace เดิม offline ได้ แต่หยุด sync จนยืนยันบัญชีถูกต้อง
- logout/account switch แยก database/cache/outbox ตามบัญชี ไม่ส่งงานค้างของบัญชี A ไปบัญชี B
- ข้อมูล guest ย้ายเข้าบัญชีด้วยกระบวนการ explicit และทดสอบ rollback; ห้ามผูกอัตโนมัติกับผู้ใช้คนถัดไป
- รุ่นแรกใช้ TLS, OS app storage protection และ backup ที่ป้องกันการเข้าถึง; SQLite ปกติไม่ได้เข้ารหัสฐานข้อมูลให้เอง
- E2EE ไม่รวมโดยอัตโนมัติ; ต้องระบุให้ชัดว่า server อาจอ่านข้อมูลได้ภายใต้นโยบายนี้

## 8. Edge cases และวิธีตรวจ

| เหตุการณ์ | พฤติกรรมที่ต้องได้ / การทดสอบ |
| --- | --- |
| วางฝ่ามือก่อน/หลังปากกา, ใช้มือซ้าย | ไม่สร้างจุดหมึกหลอก; ทดสอบ pointer cancel และ stylus-only drawing |
| pressure ไม่รองรับ/ผิดช่วง, แตะจุดเดียว | มีค่า fallback, clamp ข้อมูลผิด, จุดไม่หาย |
| เปลี่ยนยางลบกลางเส้น, OS แย่ง gesture | จบ/ยกเลิกเส้นอย่างชัดเจน ไม่เชื่อมเส้นถัดไป |
| หมุนจอ, split view, zoom ขณะเขียน | พิกัดอิงหน้าไม่อิงหน้าจอ; ไม่มีหมึกกระโดดหลัง resize |
| ปิดแอป/แบตหมดระหว่าง save | revision ที่ commit แล้วกลับมาครบ; รายการที่ยังไม่ commit ต้องไม่ถูกแสดงว่าบันทึกสำเร็จ |
| SQLite busy หรือ disk เต็ม | retry แบบมีขอบเขตและแจ้งบันทึกไม่ได้; ไม่ลบฐานเดิมเพื่อแก้ปัญหา |
| เน็ตขาดหลัง server commit ก่อนรับ response | retry แล้วได้ผลเดียว ไม่มี duplicate |
| sync พร้อมกันสองเครื่อง/หลายหน้าต่าง | revision check ป้องกันการทับ; conflict ทั้งสองฉบับยังเปิดได้ |
| นาฬิกาเครื่องผิดหรือย้าย timezone | ลำดับ sync ใช้ server sequence/base revision ไม่ใช้ local clock |
| offline นานแล้วลบ/กู้คืนอีกเครื่อง | tombstone และ recovery copy ทำงานตามกติกา; ไม่ resurrect เงียบ ๆ |
| login ผิดบัญชีหรือ logout ขณะส่ง | cancel/แยกคิวและ cache; ตรวจด้วย integration test ข้ามสองบัญชี |
| upgrade DB ล้มเหลว/เปิด format ใหม่ด้วยแอปเก่า | รักษาต้นฉบับ, migration rollback; เปิด read-only หรือแจ้งอัปเดต ไม่ล้างข้อมูล |
| หน้าใหญ่/เขียนต่อเนื่อง 30 นาที | โหลดเฉพาะหน้า, cache มีเพดาน, วัด memory/frame time/thermal |
| backup ขณะ SQLite กำลังเขียน | ใช้ consistent backup mechanism; restore DB และ attachments ได้จริง |
| server restore กลับ revision เก่า | เปลี่ยน sync epoch และ reconcile โดยไม่ล้าง local changes หรือเชื่อ cursor เดิม |
| ไทย/emoji/IME composition | ไม่ save/search โดยตัด grapheme หรือแทรก sync กลาง composition |
| ถ้ามี PDF: รหัสผ่าน/ไฟล์พัง/หน้า rotate/crop | error ที่เข้าใจได้, annotation ใช้พิกัด PDF ที่ถูกต้อง, render ทีละหน้า |
| ปิดหน้าจอ/ประหยัดพลังงาน/เน็ตต่อแต่ไม่มี internet | งานจดทำต่อได้; sync ไม่หมุน retry ถี่จนกินแบต |

## 9. เกณฑ์รับงานด้านความลื่น

ตัวเลขต่อไปนี้เป็นเป้าหมายเริ่มต้นสำหรับ release build ไม่ใช่ผลทดสอบที่ทำแล้ว:

- Cold start เข้าหน้าจอใช้งานได้ไม่เกิน 2 วินาที; เปิดหน้าที่อยู่ในเครื่อง p95 ไม่เกิน 500 ms บนชุดข้อมูลทดสอบที่กำหนด
- pen-up ถึง local commit p95 ไม่เกิน 250 ms สำหรับหน้าขนาดทดสอบปกติ; ต้องกำหนดขนาดหน้า/จำนวนจุดร่วมกับ spike
- ที่ 120 Hz มีงบหนึ่งเฟรมประมาณ 8.3 ms แต่ไม่เท่ากับ end-to-end pen latency; วัดทั้ง frame pacing และ input-to-display
- ไม่มี DB/network/export บน main thread และไม่มี whole-screen recomposition จากทุก stylus sample
- ทดสอบหน้าที่มี 1k/10k strokes, สมุด 100 หน้า, เขียนต่อเนื่อง 30 นาที และโหมดประหยัดพลังงาน
- วัด input latency เทียบ native sample ของแต่ละ SDK บนเครื่องเดียวกัน; เกณฑ์ยอมรับสุดท้ายมาจาก spike และการลองเขียนจริง
- ทุก revision ที่ UI แจ้งว่า saved แล้วต้องอยู่หลัง process-kill/reopen และหลัง retry/sync conflict
- ทดสอบ memory ไม่เพิ่มต่อเนื่องเมื่อเปิดปิดหน้าซ้ำ และบันทึกขนาดแอป/การใช้แบตเป็น baseline ก่อนเพิ่มฟีเจอร์

## 10. ลำดับดำเนินงาน

1. เตรียมตามข้อกำหนดที่ยืนยันแล้ว และปิดประเด็น Pencil/OS, signing, วิธี login, hosting และ E2EE ก่อนงานที่ขึ้นกับประเด็นนั้น
2. ทำ spike ปากกาหนึ่งหน้าในสองระบบ พร้อม common-format round trip และการวัดจริง — ไม่ผ่านให้แก้การตัดสินใจตรงนี้ก่อน
3. ทำ local MVP: สมุด/หน้า/หมึก/ข้อความ/SQLite/undo/export พร้อม crash และ migration tests
4. ทำ login + backend + revision sync + conflict UI พร้อมทดสอบ offline/retry/account isolation
5. ตรวจ usability บน S25 กับ iPad: ขนาด toolbar, มือซ้าย, landscape/split view, ไทย และ accessibility
6. ทำ backup/restore, CI และ release packaging; smoke test อุปกรณ์จริงก่อนแจก build

โครงสร้าง repo ที่เสนอ: androidApp/, iosApp/, shared/, server/, docs/ และ .github/workflows/
ให้ shared มีหน้าที่ data/persistence/sync ชัดเจน และ native canvas เก็บ input/render อยู่ใน platform ของตน
ใช้ test fixtures ของหมึกและ sync ร่วมกัน และ pin เวอร์ชัน dependencies ตาม compatibility matrix ที่ผ่าน CI
GitHub Actions ใช้ Linux ตรวจ Android/server/shared และ macOS ตรวจ iPad; signing secrets เก็บในระบบ secrets
APK แจกผ่าน GitHub Releases ได้; iPad ต้องใช้เส้นทาง signing/distribution ของ Apple ไม่ใช่เพียงดาวน์โหลด IPA จาก repo
ไม่เก็บ database จริง, โน้ตส่วนตัว, token หรือ signing key ใน Git
backend รุ่นแรกเป็น instance เดียวพร้อม local persistent disk และ backup นอกเครื่อง; ไม่ mount SQLite ร่วมหลาย replicas

### การส่งให้ผู้ใช้ทดสอบเมื่อไม่มี Mac

- GitHub Releases: release notes, Android APK ที่ signed และคู่มือทดสอบ; Android signing key ต้องคงเดิมสำหรับอัปเดตทับ
- GitHub Actions macOS runner: build และทดสอบ iPad simulator; job สำหรับ signed device build เปิดใช้เมื่อมี signing credentials
- iPad เสนอ TestFlight ผ่าน App Store Connect โดยทีมผู้พัฒนาต้องมี Apple Developer Program; ผู้ทดสอบไม่ต้องมี Mac
- ผู้ใช้ที่เป็น internal tester ของทีมใช้เส้นทาง internal testing ได้; public/external link ต้องผ่านเงื่อนไข Beta App Review
- หน้า GitHub Release ใส่ TestFlight link ได้เมื่อมี build พร้อมจริง; ไม่อ้างว่า unsigned IPA ติดตั้งได้
- TestFlight เป็นช่องทาง beta; ต้องวางแผนการต่ออายุ build/ช่องทางใช้งานระยะยาวตามข้อจำกัดของ Apple
- ถ้ายังไม่มี signing ทำ source, shared tests, Android APK และ iPad simulator build ต่อได้ แต่ต้องรายงานตรง ๆ ว่ายังไม่มี iPad build ที่ติดตั้งได้
- ไม่ใช้ PWA แทนอย่างเงียบ ๆ เพราะจะเปลี่ยนข้อกำหนดการเข้าถึง PencilKit/native APIs

## 11. เอกสารทางการที่ใช้ตรวจข้อจำกัด

- [KMP: share logic while keeping native UI](https://kotlinlang.org/multiplatform/)
- [SQLDelight multiplatform SQLite](https://sqldelight.github.io/sqldelight/2.1.0/multiplatform_sqlite/)
- [Android stylus input](https://developer.android.com/develop/ui/compose/touch-input/stylus-input)
- [AndroidX Ink release notes: stable/experimental](https://developer.android.com/jetpack/androidx/releases/ink)
- [PencilKit stroke point properties](https://developer.apple.com/documentation/pencilkit/pkstrokepointreference?language=objc)
- [S25 Ultra S Pen limitations](https://www.samsung.com/us/support/answer/ANS10004602/)
- [Apple Pencil compatibility](https://support.apple.com/en-us/108937)
- [Apple Pencil feature comparison](https://www.apple.com/apple-pencil/)
- [GitHub Pages is static hosting](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [Appropriate uses for SQLite](https://sqlite.org/whentouse.html)
- [Ktor authentication](https://ktor.io/docs/server-auth.html)
- [Google authentication](https://developers.google.com/identity/authentication)
- [Xcode system requirements](https://developer.apple.com/xcode/system-requirements)
- [GitHub-hosted macOS runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [TestFlight distribution](https://developer.apple.com/testflight/)
- [Apple developer account](https://developer.apple.com/help/account/basics/about-your-developer-account)
