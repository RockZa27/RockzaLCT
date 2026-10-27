# NovaLCT file fixtures

Real files used by the novaImport tests (parsers, address policy, replay). Do not edit them: the
tests assert golden values read from these exact bytes.

| File | Source | What it is |
|---|---|---|
| `Q8_ICND2153_40x40.rcfgx` | `cfg/` of https://github.com/sarakusha/novastar (MIT, (c) Andrei Sarakeev) | Receiving-card config made with NovaLCT V5.3.0 for an MRV328 card: 40x40 px module, Scan_5, ICN2053. 41 register writes, 6 598 data bytes. |
| `test.scr` | same repository, `cfg/test.scr` | Screen config (CRC checked): one standard screen, 5 x 3 cabinets of 40 x 40 px on 3 ports. |
| `user_NV7516_64x128_2x5.rcfgx` | user-supplied, exported from the user's own hardware with NovaLCT V5.9.2 | NV7516 card, 64 x 128 px module, Scan_32, HX6158H, 2 x 5 modules (128 x 640 px). 61 register writes, 532 212 data bytes; one record is 524 288 bytes at 0x04000000. |

The parsers are our own code; `@novastar/screen` (MIT) is used for `.scr` decoding and its RCCB
record layout is the reference for `decodeRccb`.
