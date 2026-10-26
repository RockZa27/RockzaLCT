# RockzaLCT

โปรแกรมตั้งค่าและควบคุมจอ LED (การ์ดส่ง NovaStar MCTRL / VX Pro) — ดูแผนงานใน [PLAN.md](PLAN.md)

```bash
pnpm install
pnpm build && pnpm test

# รันโปรแกรม (ต้องมี Electron binary)
pnpm --filter @rockzalct/desktop dev                         # ต่อการ์ดจริง (USB/COM + LAN)
ROCKZALCT_DEVICE=sim pnpm --filter @rockzalct/desktop dev    # ใช้การ์ดจำลองในตัว
ROCKZALCT_DEVICE=mock pnpm --filter @rockzalct/desktop dev   # ข้อมูลปลอม ไม่มีโปรโตคอล
pnpm --filter @rockzalct/simulator start                     # การ์ดจำลองแยก บนพอร์ต 5200
```

| แพ็กเกจ | หน้าที่ |
|---|---|
| `packages/shared` | สัญญา `DeviceApi` ระหว่าง UI กับฮาร์ดแวร์ |
| `packages/device` | สื่อสารกับการ์ดผ่าน `@novastar/*` |
| `packages/simulator` | การ์ดจำลองที่พูดโปรโตคอล NovaStar จริงผ่าน TCP |
| `apps/desktop` | โปรแกรม Electron + React (ไทย/อังกฤษ) |

> ค่า byte ของจอดำ / หยุดภาพ (`DISPLAY_MODE_VALUES` ใน `packages/device`) ยังไม่ได้ยืนยันกับเครื่องจริง
