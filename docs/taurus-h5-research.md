# งานวิจัย: การรองรับ Taurus (TU15 Pro / TU20 Pro / TB40 / TB50 / TB60) และ H5 (H series) ใน RockzaLCT

> วันที่ทำวิจัย: 2026-10-27 · ประเภท: research only (ไม่มีโค้ดผลิตภัณฑ์)
> ป้ายระดับความมั่นใจที่ใช้ทั้งเอกสาร:
> - **[เอกสาร]** = ยืนยันจากเอกสารทางการของ NovaStar ที่อ่านได้จริง
> - **[โค้ด OSS]** = เห็นในซอร์สโอเพนซอร์สที่โหลดมาอ่านเอง (ระบุ license)
> - **[snippet]** = ได้จากผลค้นหา/บทสรุปของหน้าเว็บ ยังไม่ได้เปิดอ่านต้นฉบับเอง
> - **[อนุมาน]** = ข้อสรุปจากเหตุผล ยังไม่มีหลักฐานตรง ต้องทดสอบกับเครื่องจริง
> - **[ไม่ยืนยัน]** = ไม่พบหลักฐาน

**ข้อจำกัดของการวิจัยนี้:** sandbox เข้าถึงโดเมนของ NovaStar ไม่ได้ (`novastar.tech`, `novastar-led.com`, `docs.vnnox.com`, `developer-en.vnnox.com` DNS ล้มเหลว) จึงอ่านคู่มือ/datasheet ต้นฉบับของ NovaStar โดยตรงไม่ได้ ข้อมูลฝั่งทางการทั้งหมดจึงเป็น **[snippet]** เท่านั้น ส่วนข้อมูลโปรโตคอลมาจากซอร์ส GitHub ที่ clone มาอ่านจริง

---

## สรุปสั้น (TL;DR)

| หัวข้อ | Taurus | H5 (H series) |
|---|---|---|
| โปรโตคอลหลักที่ใช้ได้จริง | 2 ชั้น: (1) NovaStar register protocol TCP 5200 (เหมือนกลุ่ม 1) + (2) "Taurus management protocol" TCP 16606 (TLS) + UDP discovery 16601 + FTP | "H Series Control Protocol" JSON ผ่าน **UDP พอร์ต 6000** (V1.0.19/1.0.20) |
| มีเอกสารสาธารณะทางการหรือไม่ | ชั้น (2) **ไม่พบ** เอกสารสาธารณะ; มีแต่ไลบรารี reverse-engineered `@novastar/taurus` (MIT); VNNOX Cloud Open API เป็นเอกสารสาธารณะแต่เป็น cloud | ตัวเอกสารโปรโตคอล **ไม่เปิดสาธารณะ** (ผู้ดูแล Companion บอกว่าต้อง NDA) แต่มีโมดูล Companion MIT ที่ implement จากเอกสารนั้น |
| ทำได้โดยไม่เดา | ชั้น 5200: ใช้ของที่มีอยู่แล้ว; ชั้น 16606: ทำตามโค้ด `@novastar/taurus` ได้ แต่ต้องทดสอบกับเครื่อง | ส่วนที่ Companion module ใช้ (preset, brightness, freeze, FTB, test pattern, source) ทำตามโค้ดได้ ส่วนอื่นต้องขอเอกสารจาก NovaStar |

---

## 1. Taurus

### 1(a) Built-in sending card และพอร์ต TCP 5200 / USB

| ข้อเท็จจริง | ระดับ | แหล่ง |
|---|---|---|
| README ของ `@novastar/taurus` ระบุว่าแพ็กเกจนี้ "complements the register protocol on TCP port 5200" และ "The register protocol on TCP port 5200 remains available separately through `@novastar/net`" แปลว่า Taurus เปิดพอร์ต 5200 ที่พูด register protocol เดียวกับ MCTRL/VX | **[โค้ด OSS]** (MIT) | S1 |
| โค้ด calibration ใน `@novastar/taurus` เปิด "private TCP/5200 connection" ไปยัง Taurus เพื่อโหลดค่า calibration ให้ receiving card | **[โค้ด OSS]** | S1 (README ส่วน Calibration) |
| `@novastar/screen` (ตัวถอด `.ncp`) มี comment ว่า binary ของ RCCB "accepted by Taurus ScreenService" | **[โค้ด OSS]** | S2 |
| `@novastar/native`, `@novastar/net`, `@novastar/codec`, `@novastar/serial` ที่ติดตั้งอยู่ใน `node_modules/.pnpm` (native 2.5.1, net 2.2.3, codec 2.2.3, serial 2.2.1): grep คำว่า taurus / TB\d / TU\d / viplex ใน dist/json/md/ts แล้ว **ไม่พบเลย**; ใน `net` มีแค่ default port `5200` และคำว่า broadcast/udp (ไม่ใช่ Taurus) | **ยืนยันด้วย grep ในเครื่อง** | node_modules ของ repo |
| datasheet ของ TB40/TB60 ระบุว่ามีพอร์ต USB Type-B สำหรับต่อคอมพิวเตอร์ควบคุม (TB60: "publish content and control screen") | **[snippet]** | S9, S10 |
| ว่า USB Type-B ของ Taurus พูด register protocol เดียวกับ MCTRL (ผ่าน `@novastar/serial`) หรือไม่ | **[ไม่ยืนยัน]** — `@novastar/taurus` README กล่าวถึง "LAN or USB RNDIS" สำหรับ FTP ซึ่งบอกเป็นนัยว่า USB ของ Taurus โผล่เป็น network adapter (RNDIS) ไม่ใช่ serial/COM จึง **[อนุมาน]** ว่าการต่อ USB = ได้ IP ผ่าน RNDIS แล้วใช้ TCP เหมือน LAN | S1 (+ อนุมาน) |
| Taurus "มี sending card ในตัว" | datasheet ฝั่งผู้ขายบอกว่ามีหน้าที่ playback + sending ในเครื่องเดียว **[snippet]**; ฝั่งโปรโตคอล สอดคล้องกับที่ 5200 ใช้ส่ง config receiving card | S9, S11 |

**ข้อสรุป:** มีหลักฐานดีว่าพอร์ต 5200 ใช้ได้กับ Taurus ในงาน receiving-card/calibration/screen config แต่ **ยังไม่มีหลักฐานว่าคำสั่งชุด sender (เช่น `ReadControllerModelId`, `SetGlobalBrightness` ของ `@novastar/native`) ใช้ได้ครบกับทุกรุ่น Taurus** — ต้องทดสอบกับเครื่องจริง (ดูหัวข้อ 3 และ 5)

### 1(b) API ของ Taurus สำหรับ playback / terminal management

มี 3 ชั้นที่ต้องแยกให้ชัด:

1. **Taurus management protocol (ชั้นที่ ViPlex / `novastar.js` ใช้) — ไม่มีเอกสารสาธารณะ** ที่พบ
   - พอร์ต **TCP 16606** (TLS เมื่อเปิด "privacy mode", ใบรับรอง self-signed), **UDP 16601** สำหรับ discovery (broadcast), **FTP** (พอร์ตมาจากผล discovery `ftpPort`), discovery response ยังมี `syssetTcpPort`, `terminalEntrancePortHttps`, `terminalEntrancePortWebSocket` — **[โค้ด OSS]** (S1, `discovery.ts`, `README.md`)
   - Frame: header magic `0x4e4f5641` ("NOVA" little-endian), sequence, packetType (`0x5251` request / `0x5250` response / `0x8855` discovery), `what`/`type`/`action`, length, encodeType, checksum, body เป็น JSON — **[โค้ด OSS]** (`packet.ts`)
   - Login: body JSON `{sn, username:'admin', password, loginType:0, source:{type:1,platform:2,platformVersion:'3.6.0'}, clientId, clientName}` ผ่าน command `what=0,type=0,action=0`; **ต้องรู้ `sn` จาก discovery** และรหัสผ่านของเครื่อง (ไลบรารีไม่เก็บ/ไม่เดารหัสผ่าน) — **[โค้ด OSS]**
   - ฟังก์ชันที่ไลบรารีทำได้ (v0.4.1): get/set brightness (volatile หรือ persist), environment brightness (light sensor), ตั้ง sync/async mode (HDMI vs internal player), video config (source, scaling, offset), HDMI input resolution (EDID), อ่าน/เขียน LED screen configuration (receiving-card topology), อัปโหลดไฟล์ cabinet `.bin/.rcfgx` ทาง FTP แล้ว apply, อ่านเวอร์ชัน receiving card, อัปเดต firmware receiving card, calibration จากโมดูล — **[โค้ด OSS]** (`client.ts`, README)
   - ที่มา: README หลักของ repo `sarakusha/novastar` ระบุตรง ๆ ว่าเป็น "an attempt, using reverse engineering" — **[โค้ด OSS]** (S3) **ดังนั้นชั้นนี้เป็น reverse-engineered ทั้งหมด**
   - ความสมบูรณ์: เวอร์ชัน 0.4.1 (ยังเป็น 0.x) และไม่มีหลักฐานว่าทดสอบกับทั้ง 5 รุ่นของผู้ใช้ **[อนุมาน]** ว่าพฤติกรรมต่างกันตามรุ่น/เฟิร์มแวร์/Android version ของ Taurus

2. **VNNOX / NovaCloud Open API — เอกสารสาธารณะทางการ แต่เป็น Cloud**
   - ต้องล็อกอิน NovaCloud Open Platform เพื่อรับ AppKey + AppSecret, เรียกโดเมนตามภูมิภาค (เช่น `openapi-us.vnnox.com`, path เช่น `/v2/player/list`); header ต้องมี AppKey, Nonce (8–64 ตัวอักษร), CurTime (UTC epoch วินาที, คลาดได้ ≤5 นาที), CheckSum = SHA256(AppSecret+Nonce+CurTime) **[snippet]** (S6)
   - ต้องใช้อินเทอร์เน็ต + บัญชี VNNOX และตัวเครื่องต้องผูกกับ cloud — ไม่ใช่ LAN-direct จึงไม่ตรงกับ "คล้าย NovaLCT" ที่ทำงาน offline ได้ และ **ยังไม่ได้อ่านรายการ endpoint ควบคุมจริง** (brightness/screenshot/ฯลฯ) **[ไม่ยืนยัน]** ว่ามีอะไรบ้าง ต้องเปิด S6 ด้วยเบราว์เซอร์ปกติ
   - ต้องตรวจเงื่อนไขการใช้งาน (ToS) ของ Open Platform ก่อนนำมาใช้ในซอฟต์แวร์เชิงพาณิชย์

3. **"Taurus SDK" / "ViPlex API" แบบ local** — ค้นหาแล้ว **ไม่พบ** เอกสารสาธารณะ **[ไม่ยืนยัน]** (ไม่ได้พิสูจน์ว่าไม่มี เพียงไม่พบ และเข้าเว็บ NovaStar ไม่ได้)

### 1(c) Discovery และ credential

| รายการ | ผล | ระดับ |
|---|---|---|
| Discovery | UDP broadcast ไปพอร์ต **16601** ด้วยแพ็กเก็ตไบนารีของ Taurus (packetType `0x8855`); ตอบกลับเป็น JSON มี `sn`, `tcpPort`, `productName`, `modelId`, `width/height`, `privacy`, `ftpPort`, ฯลฯ | **[โค้ด OSS]** |
| Discovery แบบเก่า | UDP 3800 ตอบแค่ marker `rpProMI:` ไม่มี serial number จึงใช้ login ไม่ได้ | **[โค้ด OSS]** (README) |
| รหัสผ่านเริ่มต้น | **ไม่มีเอกสารทางการที่อ่านได้**; โค้ด OSS ใช้ username เริ่มต้น `admin` แต่ "device password is never discovered or stored" — ห้ามเดา/ฮาร์ดโค้ดรหัสผ่านใน RockzaLCT ให้ผู้ใช้กรอกเอง | **[โค้ด OSS]** + นโยบาย |
| ค้นหา Taurus ผ่าน 5200 | ไม่มีกลไก broadcast ที่ยืนยันได้ในไลบรารี `net` ที่ติดตั้ง (มีแค่คำว่า broadcast/udp ซึ่งเป็นของ Mctrl) | grep ในเครื่อง; รายละเอียด **[ไม่ยืนยัน]** |

---

## 2. H5 / H series

### 2.1 โปรโตคอลควบคุมทางการ

| ข้อเท็จจริง | ระดับ | แหล่ง |
|---|---|---|
| มีเอกสารชื่อ **"Novastar H Series Control Protocol"** เวอร์ชัน **V1.0.19** (โมดูลระบุใน HELP.md/README) และอ้างข้อ 4.3.1, 4.3.2 (cardType), 4.7.1 (W0303), Appendix 5.3 (test pattern), และ **V1.0.20** (ข้อ 4.3.3 interfaceType) ในคอมเมนต์โค้ด | **[โค้ด OSS]** (อ้างถึงเอกสาร ไม่ได้เห็นตัวเอกสาร) | S4 |
| **ตัวเอกสารไม่เปิดสาธารณะ**: ผู้ดูแล `bitfocus/companion-module-novastar-splicer` ตอบ issue #4 ว่า "full API documentation requires an NDA with NovaStar and cannot be shared publicly" (ตามสรุปของหน้า issue) | **[snippet]** | S7 |
| ผู้ใช้ Control4 รายงานว่าต้องติดต่อ NovaStar โดยตรงเพื่อขอ API/hex commands | **[snippet]** (บอกต่อ) | S12 |
| ผลค้นหาหน้า "novastar-h-series-api" บน edx.ipeindia.org ดูเป็นหน้า SEO คุณภาพต่ำ ห้ามอ้างอิง | ไม่ใช้ | — |
| ไม่พบ OpenAPI/Swagger สาธารณะ | **[ไม่ยืนยัน]** | — |

### 2.2 รายละเอียดโปรโตคอล (จากโมดูล Companion MIT ที่อ่านโค้ดเอง)

| ประเด็น | รายละเอียด | ระดับ |
|---|---|---|
| Transport | **UDP**, ค่าเริ่มต้นพอร์ต **6000** (ตั้งค่าได้) | **[โค้ด OSS]** (kman1898 v3.0.7 `README.md`, `src/main.js`) |
| รูปแบบข้อความ | JSON array หนึ่ง datagram ต่อคำสั่ง: `[{"cmd":"W0410","deviceId":0,"screenId":0,"brightness":50}]`; คำตอบเป็น JSON array เช่นกัน มีฟิลด์ `cmd` และ `ack` (`"Ok"` = สำเร็จ) | **[โค้ด OSS]** (`utils/index.js` `handleParams`, `decodeRes`) |
| รหัสคำสั่ง | อ่าน `R0xxx`, เขียน `W0xxx` (ตารางด้านล่าง) | **[โค้ด OSS]** (`utils/constant.js`) |
| การยืนยันตัวตน (auth) | UDP: **ไม่พบขั้นตอน login/token** ในโค้ด (ส่ง JSON ตรง ๆ) — ต่างจาก HTTP API ที่ต้อง `token` | **[โค้ด OSS]** |
| Handshake | ถาม `R0118` (device init status) จน `rate==100` จึงถือว่าพร้อม; มี heartbeat `W0120`; poll สถานะทุก 500–30000 ms (default 1000) | **[โค้ด OSS]** (`src/main.js`) |
| ขนาด | สูงสุด 40 จอ (screen), 128 preset, input card ละ 4 connector | **[โค้ด OSS]** (`SCREEN_COUNT_H`, `PRESET_COUNT_H`) |
| HTTP API ที่พบในเว็บ UI | `POST /api/preset/play` `{"presetId","deviceId","screenId"}`, `POST /api/layer/screenLayerTake`; ต้อง header `token`; คนรายงานว่า admin/admin; ได้ `{"status":106,"msg":"User_Not_Login"}` เมื่อไม่มี token. นี่คือ API ภายในของเว็บ UI (H15 manual บอกว่าเป็น B/S architecture **[snippet]** S13) ไม่ใช่เอกสารทางการ | **[snippet]** (S7) — ถือเป็น **reverse-engineered/unofficial** |

ตารางคำสั่งที่อ่านจาก `utils/constant.js` (**[โค้ด OSS]**):

| ฟังก์ชัน | cmd |
|---|---|
| ข้อมูลอุปกรณ์/slot/connector + สถานะสัญญาณ | R0100 (slotList[], cardType, iSignal), R0102 |
| สถานะ init / heartbeat | R0118 / W0120 |
| รายการ input source | R0200, R0226 (simplify), W0A00 (IPC), W0B03 (NDI) |
| รายการ output / รายละเอียด output | R0300 / R0301 |
| Test pattern (ต่อ output connector) | W0303 (`testPattern`: 0xFFFF=ปิด, 0x0000 ดำ, 1 แดง, 2 เขียว, 3 น้ำเงิน, 4 ขาว, 5/6 colour bar, 7 checker, 0x0100–0x0107 gradient, 0x0200–0x0205 lines/grid, 0x0300–0x0302/0xFFFE protocol-only) |
| รายการจอ / รายละเอียดจอ (ความสว่าง ฯลฯ) | R0400 / R0401 |
| FTB (จอ) | W0409 (type 0=FTB on, 1=off) |
| Freeze จอ / BKG / OSD / Volume | W040A / W040B / W040C / W041C |
| ความสว่างจอ | W0410 (`brightness` 0–100); บันทึกลง receiving card W0417 |
| PGM/PVW/Take | W0412 |
| Layer list / Freeze layer / Source switch | R0500 / W0509 / W0506 |
| Preset list / load preset | R0600 / W0605 |
| Preset group | R0620 / W0625 |
| Blackout ทั้งระบบ | W0700 |

**หมายเหตุสำคัญ:** รูปแบบ field ของคำสั่งเขียนหลายตัว (เช่น W0409, W040A, W0605) อ่านจาก `src/actions.js` ได้ แต่เราไม่มีเอกสารฉบับเต็ม จึงรู้เฉพาะ field ที่โมดูลใช้ **[โค้ด OSS]**; field/ค่าที่โมดูลไม่ได้ใช้ = **[ไม่ยืนยัน]**

### 2.3 H series พูด NovaStar binary protocol (5200) ด้วยหรือไม่
**[ไม่ยืนยัน]** — ไม่พบแหล่งใดระบุ. มีเพียงสถาปัตยกรรม: H series มี "Sending" card (cardType=3) ในแชสซี **[โค้ด OSS]** และ NovaStar ขาย "H Series Control Card" ที่เพิ่ม RJ45 + COM ให้ควบคุมจาก PC **[snippet]** (S12) แต่ไม่มีหลักฐานว่าคุย 5200 ได้ **[อนุมาน]**: น่าจะผ่านโปรโตคอล JSON/UDP 6000 เท่านั้น. ต้องทดสอบด้วยการ connect TCP 5200 กับเครื่องจริง (ไม่เสี่ยง: แค่ `ReadControllerModelId`)

### 2.4 Companion modules และ license

| โมดูล | License | หมายเหตุ |
|---|---|---|
| `kman1898/companion-module-novastar-splicer` v3.0.7 | **MIT** (LICENSE: © 2019 Bitfocus AS & Andreas H. Thomsen) | คุยกับ H2/H5/H9/H15/H20 ทดสอบกับ H5, UDP 6000, protocol V1.0.19, มีทั้ง per-screen brightness/freeze/FTB/test pattern/blackout และ offline mode — เป็นแหล่งอ้างอิงที่ดีที่สุด |
| `bitfocus/companion-module-novastar-splicer`, `bitfocus/companion-module-novastar-h-series` | MIT (ตรวจ LICENSE ที่ clone มา) | เวอร์ชันเก่า/พื้นฐานกว่า (preset, freeze, volume, brightness +/-) |
| `bitfocus/companion-module-novastar-controller` | MIT (ตามหน้า GitHub) | ไม่ครอบคลุม H series; คุย TCP 5200 กับ MCTRL4K/VX*/J6 (ตามสรุปของ DeepWiki **[snippet]**) |

(JS ของโมดูลถูกเขียนสำหรับ Companion; เราควรเขียน TypeScript ใหม่โดยอ้างอิงโครงสร้างข้อความ ไม่คัดลอกโค้ดสำเร็จรูป ดูหัวข้อ 4)

---

## 3. ฟีเจอร์ของ RockzaLCT ที่ทำได้จากแหล่งสาธารณะ/ตรวจสอบได้

สัญลักษณ์: ✅ มีหลักฐานชัด (ทำตามได้โดยไม่เดา) · 🟡 มีหลักฐานบางส่วน ต้องทดสอบกับเครื่อง · ❌ ต้องเดา/ไม่มีข้อมูล

### Group 2 — Taurus

| ฟีเจอร์ RockzaLCT | สถานะ | เหตุผล |
|---|---|---|
| เชื่อมต่อ + ข้อมูลเครื่อง (discovery, model, SN, ขนาด) | ✅ ผ่าน UDP 16601 | **[โค้ด OSS]** `discoverTaurusPlayers` ได้ `productName`, `modelId`, `sn`, `width/height` โดยไม่ต้อง login |
| Login | 🟡 | ต้องรหัสผ่านจากผู้ใช้; แพลตฟอร์ม/เวอร์ชันที่ไลบรารีแจ้งตัว (`platformVersion 3.6.0`) อาจถูกเฟิร์มแวร์บางรุ่นปฏิเสธ |
| ความสว่าง (manual) + light sensor | ✅/🟡 | `getBrightness/setBrightness(persist)` และ `getEnvironmentBrightness` **[โค้ด OSS]**; ระบบ schedule/auto-by-sensor ของ Taurus ไม่มีในไลบรารี → ❌ |
| Test pattern | ❌ (ผ่านชั้น 16606 ไม่มีฟังก์ชัน) / 🟡 ผ่าน 5200 | ใช้ `SetSelfTestMode` ของ `@novastar/native` ผ่าน 5200 ถ้า Taurus ตอบคำสั่งชุด sender (ยังไม่ยืนยัน) |
| Blackout / freeze | ❌/🟡 | ในไลบรารี taurus ไม่มี; ถ้าผ่าน 5200 ก็ใช้ `SetKillMode`/`SetLockMode` ซึ่ง README ของเราเองก็ยังไม่ยืนยันค่า byte แม้กับ MCTRL |
| Sending card (resolution, input source) | 🟡 | HDMI input resolution (EDID) + sync/async mode **[โค้ด OSS]**; ความละเอียด output ของ canvas ผ่าน `getLedScreenSize` |
| Receiving card (cabinet params) | 🟡 | อัปโหลด `.bin/.rcfgx` ทาง FTP + `applyReceivingCardConfiguration` **[โค้ด OSS]**; การสร้าง `.bin` เองจาก parameter ต้องรู้รูปแบบ RCCB ซึ่ง `@novastar/screen` ถอดให้จาก `.ncp` เท่านั้น → การ "สร้างจากศูนย์" ❌ |
| Layout (screen connection) | 🟡 | `get/setLedScreenConfiguration` (offsets + receiving-card regions) **[โค้ด OSS]**; ไลบรารีเตือนว่าต้องอ่านจากเครื่องเดียวกันแล้วแก้ ห้ามเขียนใหม่ทั้งชุดถ้าไม่รู้แน่ |
| บันทึก/โหลด (Save to hardware / read back) | 🟡 | apply config = ค่าอยู่บน player; flash persist เฉพาะ brightness (flag `persist`); การ "save to receiving card" ของ RockzaLCT ต้องเทียบ |
| Monitoring | 🟡 | `getReceivingCardVersions` ให้ FPGA/MCU version; อุณหภูมิ/แรงดันผ่าน Taurus protocol ไม่มีในไลบรารี → ❌; ผ่าน 5200 ใช้ฟีเจอร์ monitor ที่ RockzaLCT มีอยู่ได้ถ้าเครื่องตอบ |
| Firmware/Calibration | 🟡 (มีในไลบรารี) | **เสี่ยงสูง** ไม่ควรทำเฟสแรก |
| เล่นคอนเทนต์/จัดการโปรแกรม (ViPlex) | ❌ | ไม่มีในไลบรารี taurus (นอกจาก sync/async mode); ถ้าต้องการต้อง reverse เพิ่ม หรือใช้ VNNOX Cloud API |

### Group 3 — H5

| ฟีเจอร์ | สถานะ | เหตุผล |
|---|---|---|
| เชื่อมต่อ + ข้อมูล (R0118, R0100) | ✅ | **[โค้ด OSS]**; ได้รายการ slot/card/connector + สัญญาณ |
| ความสว่าง (ต่อจอ 0–100 + save W0417) | ✅ | W0410/W0417 **[โค้ด OSS]** (ค่าถูกบันทึกลง receiving card ผ่าน W0417 ตามคำอธิบายใน HELP.md) |
| Test pattern | ✅ | W0303 + ตารางลวดลาย (ต่อ output connector; protocol-only อีก 4 ค่าให้ติดป้ายว่ายังไม่ยืนยัน) |
| Blackout / freeze | ✅ | W0700 (global blackout), W0409 (FTB), W040A (freeze), W0509 (layer freeze) |
| Layer / preset / scene | ✅ | R0500/R0600/W0605, preset group R0620/W0625, PGM/PVW/Take W0412 |
| Input source | ✅ | R0200/R0226/W0506 |
| Sending card / receiving card ของ H5 (ตั้ง resolution, cabinet) | ❌ | โมดูล Companion ไม่แตะ; ต้องขอเอกสารเต็มจาก NovaStar |
| Layout / screen config (สร้างจอ/ตำแหน่ง) | ❌/🟡 | อ่าน R0400/R0401 ได้; การเขียน screen/layer geometry ไม่มีใน module |
| บันทึก/โหลด config | ❌ | ไม่มีคำสั่ง export/import ใน module |
| Monitoring | 🟡 | สัญญาณ input (R0102) ได้; อุณหภูมิ/พัดลม/การ์ดหลุด ❌ |
| ความมั่นคงของ UDP | 🟡 | UDP ไม่มี reliability; module ต้อง rebuild socket หลัง poll เงียบ (UDP_REBUILD_AFTER_TICKS=30) และผู้ใช้ H9 รายงานค้างที่ "connecting" **[snippet]** (S5) |

---

## 4. หมายเหตุด้านกฎหมาย / IP

**แยกประเภทของแหล่งข้อมูล**

| ประเภท | ตัวอย่าง | ความเสี่ยง |
|---|---|---|
| (A) เอกสารทางการที่ NovaStar เผยแพร่สาธารณะ | คู่มือ/datasheet บน novastar.tech; docs ของ VNNOX Open API (developer-en.vnnox.com); PDF ใน `sarakusha/novastar/doc/` ที่ใส่ URL novastar.tech (เช่น VX4S Command Protocol, MCTRL660 Pro protocol, Nova M3 RS232 protocol, Mars SDK manual) | ต่ำ — ใช้ implement ตาม interface ได้ (ตรวจ ToS ของแต่ละเอกสาร/Open API; Open API ผูกกับบัญชีและข้อตกลง) |
| (B) เอกสารที่อยู่ใต้ NDA | "H Series Control Protocol V1.0.19/1.0.20" | **อย่าสร้าง/แจกซ้ำ** ถ้าไม่มีสิทธิ์ ถ้าผู้ใช้ได้เอกสารนี้มาจาก NovaStar ถูกต้อง ควรใช้ภายใต้เงื่อนไข NDA ของเขาเอง ไม่ใส่ตัว PDF หรือข้อความยาวลง repo |
| (C) ซอร์สโอเพนซอร์ส license MIT ที่ implement จาก (B) | Companion modules (MIT, S4/S5) | ใช้เป็นอ้างอิงได้ตาม MIT (ต้องคง copyright notice ถ้าคัดลอกโค้ด). ข้อความ JSON/รหัสคำสั่งคือข้อเท็จจริงของ interface; เขียนใหม่ในภาษาของเราเอง ไม่คัดลอกไฟล์ |
| (D) Reverse-engineered | `@novastar/taurus` (README ของ monorepo บอกว่า "reverse engineering"); `@novastar/native` (สร้างจาก decompiled .NET — ผู้ใช้รับทราบความเสี่ยงแล้วใน PLAN.md); HTTP `/api/...` ของเว็บ UI H series | ความเสี่ยงสูงกว่า — ต้องการข้อตกลงกับเจ้าของโปรเจกต์ (ใช้ได้ตาม MIT ในเชิงลิขสิทธิ์โค้ดของผู้เขียน แต่ไม่ได้ให้สิทธิ์เหนือทรัพย์สินทางปัญญาของ NovaStar) |

**ข้อเสนอแนะ**
1. อย่าฝัง/แจก firmware, DLL, PDF ของ NovaStar ใน repo (สอดคล้อง PLAN.md ข้อ 1).
2. ขอเอกสารทางการจาก NovaStar/ตัวแทนในนามผู้ใช้ที่เป็นเจ้าของเครื่อง: "H Series Control Protocol" และเอกสาร Taurus ที่เกี่ยวข้อง (ถ้ามี) — ลดความเสี่ยงและอุดช่องว่างที่ต้องเดา.
3. อย่าใช้รหัสผ่านเริ่มต้นฮาร์ดโค้ด ให้ผู้ใช้กรอกเอง.
4. ห้ามอ้างว่า "เป็นผลิตภัณฑ์ของ NovaStar" ใน UI; ชื่อรุ่น (TB40, H5) ใช้เชิงบอกความเข้ากันได้ (nominative use) เท่านั้น.
5. นี่ไม่ใช่คำปรึกษากฎหมาย — แนะนำให้ผู้เชี่ยวชาญตรวจก่อนจำหน่ายเชิงพาณิชย์.

---

## 5. ข้อเสนอแผนพัฒนาแบบเป็นเฟส (ตาม feature-seam architecture ของ repo)

**สภาพ repo ปัจจุบัน:** `packages/device/src/factories.ts` มี `createNetSessionFactory` (TCP 5200 ผ่าน `@novastar/net`) และ factory serial; `service.ts` ใช้ `@novastar/native/api/*` ผ่าน codec `Session`; ฟีเจอร์แยกเป็น seam `packages/shared/src/features/*` (สัญญา) กับ `packages/device/src/features/*` (เวอร์ชันที่คุยกับ device) และ `packages/simulator` พูดโปรโตคอล 5200 ผ่าน TCP. `PLAN.md` ระบุกลุ่ม 2 "ตั้งค่าจอผ่านโปรโตคอลเดียวกันได้บางส่วน ต้องตรวจทีละรุ่น" และกลุ่ม 3 "มี API ของตัวเองแยก" — ผลวิจัยนี้สนับสนุนทั้งสองข้อ.

### หลักการ
- เพิ่ม **"device family"** เป็นแนวคิดระดับบน (เช่น `family: 'sender' | 'taurus' | 'hseries'`) และ **capability flags ต่อ family** (brightness, testPattern, blackout, freeze, presets, layers, monitoring, receiverConfig …) เพื่อให้ UI ซ่อนฟีเจอร์ที่ไม่รองรับ แทนที่จะแสดงปุ่มที่ใช้ไม่ได้.
- **แยก transport/factory ต่อ family**: Taurus = 5200 (ของเดิม) + client 16606 ใหม่; H series = UDP JSON client ใหม่. ไม่ยัดลง `SessionFactory` เดิมที่ผูกกับ codec `Session`.
- แต่ละ client ใหม่ implement **interface เดียวกับ seam เดิม** (`sender`/`monitor`/ฯลฯ) หรือ interface ย่อยตาม capability เพื่อให้ไม่ต้องแก้ UI มากนัก.

### เฟส A — เตรียมโครง (ไม่ต้องมีฮาร์ดแวร์)
1. เพิ่ม `DeviceFamily` + `Capabilities` ใน `packages/shared` และผลักให้ `DiscoveredController` มี `family`/`model`.
2. Refactor `service.ts` ให้เลือก backend ตาม family (strategy), ไม่เปลี่ยนพฤติกรรมของ sender family เดิม; เพิ่ม unit test ยืนยัน.
3. เพิ่มกลไก discovery ที่เป็นปลั๊กอิน (list ของ discoverer): LAN scan เดิม + Taurus UDP 16601 + H series (ดู B/C).
- ทดสอบได้ทั้งหมดโดยไม่มีเครื่อง.

### เฟส B — H series (ความเสี่ยงต่ำสุด ข้อมูลดีสุด) → แนะนำทำก่อน Taurus
1. `packages/device/src/hseries/` (transport UDP JSON): `client.ts` (ส่ง/รอ ack ตาม `cmd`, timeout, retry, serialise คำสั่ง, rebuild socket), `commands.ts` (R/W code ตามตารางหัวข้อ 2.2) — **เขียนใหม่เป็น TypeScript เอง** โดยอ้างอิงโครงสร้างที่ MIT โมดูล Companion ใช้.
2. Features ที่รองรับรอบแรก: connection/info (R0118, R0100), brightness ต่อจอ (W0410, save W0417), test pattern (W0303; แสดง 23 ค่าที่มีป้ายใน HELP; ซ่อน/ติดป้าย protocol-only 4 ค่า), blackout/FTB/freeze (W0700, W0409, W040A), preset load/group + PGM/PVW/Take, input source switch, สถานะสัญญาณ (R0102).
3. UI: หน้า "Video wall" แยก (presets, layer, source) เพราะแนวคิดต่างจากการ์ดส่ง; ใช้ capability flags.
4. `packages/simulator`: เพิ่ม **H-series UDP simulator** (รับ JSON array, ตอบ `ack:"Ok"` + payload แบบ R0118/R0100/R0400/R0401/W-commands จำลอง) — ทดสอบ contract ฝั่งเรา; ข้อควรระวัง: simulator ยืนยันเพียงว่าเราปฏิบัติตามโครงสร้างที่เรา *เชื่อ* ไม่ใช่ว่าเครื่องจริงตรงกัน.
5. Hardware checklist: เพิ่มส่วน H5 ใน `docs/hardware-test-checklist.md` (R0118 ตอบ rate=100?, brightness ย้อนอ่านตรง?, test pattern กลับเป็น 0xFFFF ได้?).
- ทดสอบได้ไม่ต้องมีเครื่อง: codec ของข้อความ, ตัวจัดคิว/timeout/retry, state machine ของ handshake, simulator end-to-end.
- ต้องมีเครื่อง H5: ความถูกต้องของค่า field จริง, พฤติกรรม UDP ในเครือข่ายจริง, ค่า protocol-only.

### เฟส C — Taurus ผ่าน TCP 5200 (ใช้โค้ดเดิม; ทดสอบสมมติฐาน)
1. เปิด Taurus ผ่าน `createNetSessionFactory` ที่มีอยู่ เพียงเพิ่ม model mapping (`modelName()` ใน `service.ts` ปัจจุบันรู้จักเฉพาะ MCTRL/VX) หลังจากรู้ `ReadControllerModelId` ของแต่ละรุ่นจากเครื่องจริง (**ห้ามเดา model ID**).
2. ทำ "probe" แบบอ่านอย่างเดียว: connect 5200 → `ReadControllerModelId`, `ReadSender_*ProgramEdition`, `ReadAllBrightnessInfo` เพื่อบันทึกว่าเครื่องไหนตอบอะไร → ผลลงใน capability matrix (ไฟล์ข้อมูล ไม่ฮาร์ดโค้ด).
3. เฉพาะ operation ที่ probe สำเร็จจึงเปิดใน UI (receiver/monitor ที่มีอยู่แล้ว).
- ต้องมีเครื่องจริงทั้งหมด; ไม่มีทางยืนยันโดย simulator.

### เฟส D — Taurus management protocol 16606 (reverse-engineered; ทำเป็นตัวเลือก)
1. ตัดสินใจทางเลือก: (i) เพิ่ม dependency `@novastar/taurus` (MIT, เหมือนที่ใช้ `@novastar/*` อยู่แล้ว) แล้วห่อด้วย adapter ของเรา หรือ (ii) เขียน client ของเราเองตาม frame ที่อ่านได้จาก `packet.ts`. แนะนำ (i) ก่อนเพราะเป็นไลบรารี `@novastar/*` ตระกูลเดียวกัน แต่ **pin เวอร์ชัน** (0.x) และห่อ adapter เพื่อเปลี่ยนภายหลังได้.
2. Features: discovery (UDP 16601), login (ผู้ใช้กรอกรหัสผ่านเอง ไม่เก็บ plaintext; ใช้ secure storage ของ Electron), brightness (+persist), sync/async mode, video source/HDMI resolution, อ่าน LED screen configuration และเวอร์ชัน receiving card. ปุ่มเขียนทับ (setLedScreenConfiguration, firmware, calibration) ใส่ท้ายสุดพร้อมการยืนยัน/สำรองข้อมูล (สอดคล้อง PLAN.md ความเสี่ยงข้อ 2).
3. Simulator: เพิ่ม Taurus protocol simulator ใน `packages/simulator` (TCP 16606 ไม่ต้อง TLS สำหรับเทสต์ เพราะไลบรารีรองรับ `privacy:false`; UDP 16601 discovery) — ใช้ spec test ของไลบรารี (`packet.spec.ts`, `client.spec.ts`) เป็นแนวทางสร้าง fixture.
- ทดสอบได้โดยไม่มีเครื่อง: เฟรม encode/decode, discovery parse, client logic.
- ต้องมีเครื่อง: login จริง, ความเข้ากันได้ต่อรุ่น (TU15 Pro/TU20 Pro/TB40/TB50/TB60) และ firmware, ผล `setLedScreenConfiguration`.

### เฟส E (ทางเลือก)
- VNNOX Cloud Open API เป็น backend แบบ "remote" สำหรับ playback/terminal management ถ้าผู้ใช้ต้องการจัดการคอนเทนต์ — ต้องบัญชี cloud, ต้องอ่านสเปกฉบับเต็มก่อน (ยังไม่ได้อ่าน).
- H series: ขอ "H Series Control Protocol" ฉบับเต็มจาก NovaStar เพื่อเติม screen/layer geometry, sending/receiving card, config save/load.

### สรุปสิ่งที่ทดสอบได้โดยไม่มีฮาร์ดแวร์ vs ไม่ได้

| ส่วน | ไม่ต้องมีเครื่อง | ต้องมีเครื่อง |
|---|---|---|
| โครง family/capability, discovery plugin | ✅ | — |
| H series UDP client + simulator | ✅ (contract) | ค่า field/พฤติกรรมจริง |
| Taurus 16606 client + simulator | ✅ (frame/logic) | login, ความเข้ากันได้ต่อรุ่น |
| Taurus ผ่าน 5200 | ❌ | ✅ ทั้งหมด |
| model ID mapping ของ Taurus | ❌ | ✅ (อ่านจากเครื่อง) |

---

## 6. รายการที่ยังยืนยันไม่ได้

1. USB Type-B ของ Taurus ทำงานแบบ RNDIS network (ที่ README ใบ้) หรือ serial/COM; รองรับ `@novastar/serial` หรือไม่
2. Taurus ตอบคำสั่ง sender ของ `@novastar/native` (ReadControllerModelId, SetGlobalBrightness, SetSelfTestMode, SetKillMode, SetLockMode) ได้ครบทุกรุ่นหรือไม่ และ model ID ของแต่ละรุ่น
3. `@novastar/taurus` v0.4.1 ทำงานกับ TU15 Pro/TU20 Pro/TB40/TB50/TB60 ครบหรือไม่ (ไม่พบหลักฐานการทดสอบรายรุ่น)
4. รหัสผ่าน login เริ่มต้นของ Taurus (ไม่มีเอกสารทางการ จงไม่เดา)
5. รายการ endpoint ควบคุมใน VNNOX Open API และ ToS (อ่านเฉพาะหน้า auth จาก snippet; โดเมนเข้าไม่ได้)
6. ตัวเอกสาร "H Series Control Protocol" (ไม่ได้อ่าน; สรุปจากโค้ด Companion และบทสรุป issue)
7. ข้อความ "ต้อง NDA" ของ H series — ได้จากสรุป WebFetch ของหน้า issue เท่านั้น; ควรเปิดอ่านต้นฉบับ
8. H series พูด TCP 5200 ด้วยหรือไม่
9. ว่าโปรโตคอล UDP 6000 มี authentication/ล็อกจาก UI ได้หรือไม่ (ในโค้ดไม่พบ login แต่เฟิร์มแวร์บางเวอร์ชันอาจต่างกัน)
10. ข้อมูลสเปกพอร์ตของแต่ละรุ่น Taurus (จำนวน LAN out, 5200 แยกพอร์ตหรือไม่) — ต่างกันระหว่างผู้ขายใน snippet
11. ความหมายเชิงกฎหมายของการใช้ `@novastar/taurus`/`native` (ไม่ได้ตรวจ)

---

## 7. แหล่งอ้างอิง (Sources)

- S1 `@novastar/taurus` README + source (MIT, v0.4.1): https://github.com/sarakusha/novastar/tree/main/packages/taurus — อ่านจาก clone `git clone https://github.com/sarakusha/novastar`; npm: https://www.npmjs.com/package/@novastar/taurus
- S2 `@novastar/screen` (`NcpConfig.ts`, README): https://github.com/sarakusha/novastar/tree/main/packages/screen
- S3 README หลัก (ระบุ "reverse engineering", รายการแพ็กเกจ, MIT): https://github.com/sarakusha/novastar
- S4 Companion: kman1898 novastar-splicer v3.0.7 (MIT): https://github.com/kman1898/companion-module-novastar-splicer (HELP.md, `utils/constant.js`, `utils/index.js`, `src/main.js`)
- S5 Companion: bitfocus novastar-splicer / novastar-h-series (MIT): https://github.com/bitfocus/companion-module-novastar-splicer , https://github.com/bitfocus/companion-module-novastar-h-series ; Issue #2 "communication Novastar H series": https://github.com/bitfocus/companion-module-novastar-splicer/issues/2
- S6 VNNOX Open Platform "API Access Guide": https://developer-en.vnnox.com , https://developer-cn.vnnox.com (อ่านผ่าน snippet เท่านั้น)
- S7 Issue #4 "HTTP Protocol how to" (NDA, /api/preset/play): https://github.com/bitfocus/companion-module-novastar-splicer/issues/4
- S8 Companion novastar-controller (MIT, ไม่ครอบคลุม H): https://github.com/bitfocus/companion-module-novastar-controller , https://deepwiki.com/bitfocus/companion-module-novastar-controller
- S9 TB40 specification (สำเนาผู้ขาย): https://www.dicomp.com.br/downloads/materiais_apoio/datasheet/33419-1.pdf (และ 31282-1, 31283-1); https://olympianled.com/products/novastar-tb40
- S10 Taurus spec ของ NovaStar ที่โฮสต์บน docs.vnnox.com (TB3 V1.6.5, TB6 V1.7.0, T30 V1.0.1): https://docs.vnnox.com/download/attachments/28312199/Taurus%20Series%20Multimedia%20Player%20TB6%20Specifications-V1.7.0.pdf?api=v2 (ยังไม่ได้เปิดอ่าน)
- S11 สรุปผู้ขาย Taurus: https://www.ledincloud.com/novastar-taurus-multimedia-players/ , https://www.ledscreenboard.com/novastar-multimedia-player-guide/
- S12 RTI driver "Novastar H Series Lite" (UDP/RS232, ไม่ใช่เอกสารทางการ): https://driverstore.rticontrol.com/driver/novastar-h-series-lite ; H Series Control Card (B&H): https://www.bhphotovideo.com/c/product/1972432-REG/novastar_h_series_control_card.html ; กระทู้ Control4: https://reddit.birdcat.cafe/r/Control4/comments/1jp3eau/novastar_h5_control/ml4b6k6/
- S13 H15 Specifications V1.6.0 (B/S architecture): https://www.ac-et.com/storage/product_images/novastar/h-series-video-splicing-processor-series/h15-video-wall-splicer-specifications-v1.6.0.pdf ; ดาวน์โหลดทางการ: https://www.novastar.tech/downloads (เข้าไม่ได้จาก sandbox)
- S14 เอกสารโปรโตคอลที่แนบใน `sarakusha/novastar/doc/` (VX4S, MCTRL 660 Pro, Nova M3 RS232, Mars SDK): https://github.com/sarakusha/novastar/tree/main/doc (เป็นเอกสารที่อ้างว่ามาจาก NovaStar; สถานะการเผยแพร่ซ้ำไม่ได้ตรวจ)
- ตรวจในเครื่อง: `/home/user/RockzaLCT/node_modules/.pnpm/@novastar+{native@2.5.1,net@2.2.3,codec@2.2.3,serial@2.2.1}*` และ `/home/user/RockzaLCT/{PLAN.md,README.md,packages/device/src/{service,factories}.ts}`
