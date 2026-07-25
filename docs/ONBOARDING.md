# snJava — Onboarding (5 นาที)

คู่มือสั้น ๆ สำหรับคนเพิ่งเริ่มใช้ snJava บน ServiceNow
เอกสารเต็ม: [`../README.md`](../README.md)

> 📸 ภาพในเอกสารนี้เป็น screenshot จริงจาก dev instance (`mfecplcdemo10`)
> ถ้าภาพไหนยังไม่ขึ้น ดูวิธีถ่าย/เติมที่ [`images/README.md`](./images/README.md)

---

## 1. ติดตั้ง

```bash
npm install && npm run build
```

เปิด `chrome://extensions` → เปิด **Developer mode** (มุมขวาบน) → **Load unpacked** → เลือกโฟลเดอร์ `dist/`

![ติดตั้งด้วย Load unpacked](images/01-install.png)

> อัปเดตครั้งต่อไป: `git pull && npm run build` แล้วกด ↻ ที่การ์ด extension

---

## 2. เปิด side panel

เปิดหน้า ServiceNow แล้วคลิกไอคอน **snJava** บน toolbar → panel เปิดขึ้นและอ่าน **table + sys_id** ของ record ที่อยู่ให้อัตโนมัติ

![Inspect tab แสดง Page context](images/02-inspect.png)

แท็บทั้งหมด: **Inspect · Tester · Generate · Spec · Settings**
ถ้าเปลี่ยนหน้า/เปลี่ยนแท็บ browser panel จะ detect ใหม่เอง (หรือกด **Refresh**)

---

## 3. ตั้งค่า AI (ทำครั้งเดียว)

ไปแท็บ **Settings** → **AI Settings** → กด **Use MFEC AgentHub preset** แล้วใส่ **API key / token** → **Save settings** → กด **Test connection**

![Settings tab — AI Settings](images/03-settings.png)

- ฟีเจอร์ AI (Java review, Generate, AI spec overview) จะซ่อนอยู่จนกว่าจะตั้งค่าเสร็จ — ฟีเจอร์ที่ไม่ใช้ AI ใช้ได้เลยทันที
- ด้านล่างมี **Prod guard — sub-prod patterns**: การเขียนทุกอย่างถูกบล็อกบน production โดยดีฟอลต์ อนุญาตแค่ hostname ที่เป็น sub-prod

---

## 4. รีวิว/แก้ script (ใช้บ่อยสุด)

บนฟอร์ม ServiceNow ที่มี script field จะมีชิป **javaHelp** อยู่ข้าง label ของ field — คลิกแล้ว snJava จะเปิด panel, โหลด script เข้าแท็บ **Tester** และตั้ง Script kind ให้เอง

![ชิป javaHelp ข้าง field label](images/04-javahelp.png)

จากนั้นในแท็บ Tester:

1. พิมพ์ปัญหา/สิ่งที่ต้องการใน **Intent & change requests**
2. กด **Java review** → ได้ findings + **Optimized script**
3. อยากรันจริง: **Test Runner** → **Run on instance** (มี prod guard คุม)

![ผล Java review](images/05-review.png)

---

## 5. สร้าง artifact จาก requirement

แท็บ **Generate** → พิมพ์ requirement → **Generate plan** → คลิกดูรายละเอียดแต่ละ artifact → **Create in instance** (หรือ **Create all**)

![Generate plan + artifact detail](images/06-generate.png)

record ที่เป็นของ dev/admin (Business Rule, Client Script, Script Include, UI Policy, …) จะถูกตั้งชื่อเป็น `[MF-AI][INC] ...` ให้อัตโนมัติ — ยกเว้น Field / Table / ACL / Choice

---

## 6. ออก Design Spec

แท็บ **Spec** → **Discover artifacts** → ติ๊กเลือกที่ต้องการ → **Export: HTML / PDF / Word**

![Spec tab — checklist + export](images/07-spec.png)

---

## 7. ย้าย record ข้าม instance (XML)

แท็บ **Inspect** → บน instance ต้นทางกด **Copy record** → เปลี่ยนไป instance ปลายทาง → **Paste**
หลัง import จะมีปุ่ม **Copy sys_id / Open** ต่อแถว, **Open N record(s) as list**, และ **Undo last import**

![XML paste + ผลลัพธ์](images/08-xml.png)

---

## ติดปัญหา?

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| panel ขึ้น "Open a ServiceNow page to detect context." | ยังไม่ได้อยู่บนหน้า `*.service-now.com` |
| ไม่เห็นชิป javaHelp | ฟอร์มยังโหลดไม่เสร็จ — รอ 2–3 วิ หรือ refresh หน้า (Next Experience ฟอร์มอยู่ใน iframe ซ้อน) |
| ปุ่มเขียน (Create/Delete/Paste) กดไม่ได้ | prod guard บล็อก — instance ถูกมองเป็น production ตรวจ sub-prod patterns ในแท็บ Settings |
| ฟีเจอร์ AI ไม่ขึ้น | ยังไม่ได้ตั้ง endpoint + key ในแท็บ Settings |
| หลัง reload extension แล้ว panel error | กด **Refresh** ใน panel (content script จะถูก re-inject ให้เอง) |
