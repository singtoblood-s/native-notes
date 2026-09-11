# NotePad repair guide — 2026-09-11

This release keeps the web notebook writing-first on iPad and Samsung while
making notebook and page actions easy to find. It requires login and stores
each account in its own local SQLite workspace before syncing through the
configured HTTPS backend.

## What changed

- The `⋯` menu beside a notebook or page exposes Rename, Duplicate, and
  Trash/Restore. The same actions are available from notebook cards and the
  page list, so Text does not need to be open.
- Text and page details can insert PNG, JPEG, WebP, or GIF images from a file
  or clipboard. Large images are resized for practical offline storage. In
  Hand mode, select an image to drag, resize, nudge, or remove it. Images are
  saved in the page snapshot and travel through the existing revision sync.
- Continuous view keeps pages in their stored order and renders real ink/image
  previews for pages outside the active writing surface. Book scroll lays the
  same ordered slots horizontally. Page turn keeps the focused single page.
  The preference is saved per account and device. Add page remains available
  at the end of the flow.
- Settings shows the web build label and a Reload app control. Reload first
  flushes durable saves and refuses to interrupt an active stroke.

## Device checks

1. Sign in with the same account on two devices. Create a notebook, rename it
   through `⋯`, add two pages, and check that page order stays the same.
2. Insert one image from a file and paste one image from the clipboard. Select
   Hand, drag and resize each image, remove one, reload, and verify the result.
3. Write on the active page in Continuous view, scroll to a neighboring page,
   and write directly on its visible preview. The page activates for the
   stroke; confirm that the first contact remains intact.
4. Switch to Book scroll and Page turn, then reload and confirm that the chosen
   view returns. Check portrait and landscape orientation.
5. Move a page and a notebook to Trash, restore them from the visible menu,
   and verify that their text, ink, and images remain intact.
6. Make a small edit on device A, wait for the sync status, and bring device B
   to the foreground. Use different pages for independent edits; edit one page
   offline on both devices to confirm a recoverable conflict copy.

Use non-sensitive sample notes for device testing. Export a backup before
clearing browser data or changing the backend URL. Physical Apple Pencil and
S Pen pressure, palm rejection, latency, and suspend/resume still require
testing on the actual hardware.

## เริ่มใช้งานอย่างเร็ว

- เลือกโหมดหน้าได้ที่ **View**: Continuous สำหรับเลื่อนลง, Book scroll สำหรับ
  เลื่อนแนวนอน และ Page turn สำหรับดูทีละหน้า ปุ่ม **＋** ท้ายกองหน้าจะเพิ่มหน้า
  ต่อท้ายสมุด
- ปุ่ม **⋯** ข้างชื่อ notebook หรือ page ใช้เปลี่ยนชื่อ ทำสำเนา ย้ายไปถังขยะ
  และกู้คืน โดยไม่ต้องเปิด Text
- เปิด **Text** เพื่อเลือก **Insert image** หรือ **Paste image** จากนั้นเลือก
  Hand เพื่อเลื่อน ย่อขยาย ขยับ หรือลบรูป
- กด **Reload app** ใน Settings หลังการเขียนหยุดแล้ว แอปจะบันทึกงานค้างก่อน
  โหลดใหม่ เปิดอุปกรณ์ทั้งสองด้วยบัญชีเดียวกัน และตั้งค่า frontend กับ backend
  ให้ใช้บริการ HTTPS ชุดเดียวกันเมื่อเผยแพร่ format 2

การเขียนด้วย Apple Pencil หรือ S Pen จริงยังต้องตรวจบนอุปกรณ์จริง โดยเฉพาะ
แรงกด การกันฝ่ามือ ความหน่วง และการกลับจากการพักหน้าจอ
