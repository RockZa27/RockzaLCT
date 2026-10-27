# RockzaLCT

โปรแกรมตั้งค่าและควบคุมจอ LED (การ์ดส่ง NovaStar MCTRL / VX Pro) — ดูแผนงานใน [PLAN.md](PLAN.md)

## ติดตั้งโปรแกรม (ผู้ใช้ Windows)

1. ดาวน์โหลด `RockzaLCT-Setup-<เวอร์ชัน>.exe` จากหน้า **Releases** ของ GitHub (หรือ Actions → รัน **Release (Windows)** → Artifacts)
2. ดับเบิลคลิกติดตั้ง (ตัวติดตั้งไม่ได้เซ็นดิจิทัล Windows SmartScreen จะเตือน เลือก **More info → Run anyway**)
3. เปิดโปรแกรม **RockzaLCT** — ค่าเริ่มต้นคือโหมด **เครื่องจริง** (USB/COM + LAN)
4. ลองโดยไม่มีฮาร์ดแวร์: เปิดด้วย `RockzaLCT.exe --sim` (การ์ดจำลองในตัว) หรือ `--mock` (ข้อมูลปลอม) เช่น เพิ่มต่อท้ายช่อง Target ของทางลัด

ทดสอบกับเครื่องจริงตาม [docs/hardware-test-checklist.md](docs/hardware-test-checklist.md)

## พัฒนา / build

ต้องใช้ Node 22 และ pnpm 10.28.0

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm build

# รันโปรแกรม (ต้องมี Electron binary)
pnpm --filter @rockzalct/desktop dev                         # ต่อการ์ดจริง (USB/COM + LAN)
ROCKZALCT_DEVICE=sim pnpm --filter @rockzalct/desktop dev    # ใช้การ์ดจำลองในตัว
ROCKZALCT_DEVICE=mock pnpm --filter @rockzalct/desktop dev   # ข้อมูลปลอม ไม่มีโปรโตคอล
pnpm --filter @rockzalct/simulator start                     # การ์ดจำลองแยก บนพอร์ต 5200
```

## สร้างตัวติดตั้ง Windows

ตัวติดตั้งสร้างบน Windows เท่านั้น (ต้องใช้ native module ของ Electron) — ใช้ GitHub Actions:

- **ด้วยมือ:** แท็บ Actions → **Release (Windows)** → Run workflow → ดาวน์โหลด `RockzaLCT-Setup` จาก Artifacts
- **ออก release:** `git tag v0.1.0 && git push origin v0.1.0` — workflow จะ build แล้วแนบ `.exe` ไว้ที่ GitHub Release อัตโนมัติ
- **บนเครื่อง Windows:** `pnpm install && pnpm build && pnpm --filter @rockzalct/desktop dist:win` ผลลัพธ์อยู่ที่ `apps/desktop/release/RockzaLCT-Setup-<เวอร์ชัน>.exe`

เวอร์ชันของตัวติดตั้งมาจาก `version` ใน `apps/desktop/package.json` สคริปต์ `apps/desktop/scripts/dist.mjs` อธิบายวิธีจัดการ pnpm และ native module (`serialport`) ไว้ในคอมเมนต์ CI ปกติ (`ci.yml`) รัน typecheck / test / build ทุก push และ pull request

| แพ็กเกจ | หน้าที่ |
|---|---|
| `packages/shared` | สัญญา `DeviceApi` ระหว่าง UI กับฮาร์ดแวร์ |
| `packages/device` | สื่อสารกับการ์ดผ่าน `@novastar/*` |
| `packages/simulator` | การ์ดจำลองที่พูดโปรโตคอล NovaStar จริงผ่าน TCP |
| `apps/desktop` | โปรแกรม Electron + React (ไทย/อังกฤษ) |

> ค่า byte ของจอดำ / หยุดภาพ (`DISPLAY_MODE_VALUES`) และคำสั่งบันทึกลงแฟลช (`SAVE_COMMAND_VALUES`) ใน `packages/device` ยังไม่ได้ยืนยันกับเครื่องจริง
