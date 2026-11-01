# NovaLCT protocol notes (interoperability research)

> Facts learned by decompiling the user's own NovaLCT V5.9.2 install (ilspycmd), written in our own words: addresses, byte values, formulas, and the assembly/type/member each came from. No NovaStar code or files are included. Nothing here is hardware-tested yet; the parts the researcher marked least checked are the SDRAM-to-slave-flash command and byte offsets inside the 0x02 register block.


Method: ilspycmd 11.2.0.10050 (dotnet SDK 10 installed via apt; dot.net install script was blocked by the proxy with 403, apt worked). 183 of the NovaLCT assemblies were decompiled into `/tmp/claude-0/-home-user-RockzaLCT/f908e8b2-411c-5186-8735-4cac1b9b3632/scratchpad/novadecomp/` (outside both repos). Nothing was copied into RockzaLCT. `/home/user/novalct/Source` holds only drivers/installers, no source.

Terminology: "addr" = 32 bit register address (high16:low16 on the wire). `devType` = the device-type byte of the NovaLCT request (0 = sender, 1 = receiving card/scanner, 3 = distributor/"Hub", 4 = Sender3D). Broadcast = sender 0xFF, port 0xFF, card 0xFFFF. Multi-byte values are little-endian (helper PatchData... writes `(byte)(v >> 8*i)`).

Confidence key: HIGH = read directly in the code that the UI executes; MED = inferred from code structure; LOW = guess.

---

## Q1. Blackout / freeze (0x02000100 / 0x02000102)

Finding
- Blackout on = write `0xFF` (255) to 0x02000100, off = `0x00`. Freeze (lock) on = `0xFF`, off = `0x00`. One byte. The values 1 / 2 are NOT used: `ControlModeType` (Normal 0, Black 1, Lock 2) exists in the enum DLL but no decompiled code writes it to these registers. `KillMode` enum: NormalMode = 0, Kill = 255.
- Target is the receiving card (devType 1). NovaLCT sends it per sender, port and card = 0xFFFF (all cards): kill uses each screen's (sender, port) pairs; the lock switch uses sender = each sender, port = 0xFF.
- Evidence: `ScanBoardAccessor.ProtocolLibV3Command.SendBlackTestFrame / SendLockTestFrame / SetKillMode` (255 or 0); `Nova.LCT.GigabitSystem.LEDConfigAccessor ... Accessors.Correction.CorrectionGlobal.SetKillScreenDisplay` (`killMode = bKill ? 255 : 0`) and `.SendLockSwitchCmd` (`lockMode = isLock ? 255 : 0`); `Nova.SILayer.CommunicationProtocol.ThirdGenerationAddressMappingScanBoard.KillModeAddr=0x02000100 / LockModeAddr=0x02000102 (occupancy 1)`; `ScreenOperateController.SendLockSwitchCmd`.
- Per-model difference: none found. `ProtocolLibV4Command.SetKillMode` is a stub returning "unknown" (4th-gen controller path does not implement it).
- The write order NovaLCT uses before pushing a full config: kill=0 then lock=0 to the card (`ScannerPropertyAccessorNew.GetReadoutCommandPackage`). Register 0x02000101 (self-test) is a third thing: TestMode values Red 2, Green 3, Blue 4, White 5, HLine 6, VLine 7, Incline 8, GrayIncrease 9, Age 10, HardwareScreen 11, Logo 16, **ParaFreeze 32, OEFreeze 64** (NovaLCT writes 32 / 64 there to "lock parameters" while editing, 0 to unlock; `LowBrightnessPerformer.SendLockParameters`, 25 ms delay). That is not the user-visible freeze.
- Confidence: HIGH for 0xFF/0x00 and receiver devType; MED that the user-visible NovaLCT main-window buttons use exactly these (the callers I found are the correction/low-brightness/lock-switch paths and the ProtocolLibV3 helper).
- Separate: DisplayModeType (what to show when cable disconnected / no DVI, register 0x03100101 = 51380481, 1 byte): bits0-1 = offline mode (0 black, 1 last frame, 2 logo), bits2-3 = no-DVI mode (0 black, 4 last frame, 8 logo).

## Q2. Save to flash

Finding (main "Save to HW" = solidify, `Form_LEDScreenConfig.SendSaveParams` / `crystalButton_saveToHW_Click` sets `_solidify=true`):
1. Write 1 byte `0x00` to 0x01000001 (SaveSendCardsParameters), devType 0, sender = 0xFF (broadcast), timeout 10000 ms.
2. wait 50 ms.
3. Write 1 byte `0x00` to 0x05000000 (SaveDistributeParameter), devType 3, sender 0xFF, port 0xFF, card 0xFFFF, timeout 10000.
4. wait 50 ms.
5. only when solidify: write 1 byte `0x00` to 0x01000011 (ParameterStore2SpiFlash), devType 1, sender 0xFF, port 0xFF, card 0xFFFF, timeout 3000 ms (13000 when not routed through the LCT server proxy).
6. wait 50 ms, then write 1 byte `0x00` to 0x01000011 with devType 4 (Sender3D), same broadcast, same timeout.
- All four requests are wrapped in a "special package" id 6 (SAVE_PARAMS) so the server serialises them. Failure of any ack aborts with the message "save to hardware failed".
- Other variants in the same DLLs: `FrmFlashHW.btn_save_Click` writes `0x01` to 0x01000011 (broadcast 255/255/65535) and then polls the card (below). `ProtocolLibV3Command.SendScanBord` (the path that builds .rcfgx / "NCP" files) uses 0x01000011 with `0x03` (10 s timeout, 300 ms after) and `0x05` (factory area) then `0x00` (with theoretical/over-time waits). So the byte value is not constant across paths: 0, 1, 3, 5 all appear; the main UI path uses 0.
- Verification/polling: `HardwarePoll.CheckScannerIsFree` -> `PollingScannerRegisterAccessor`: reads 256 bytes from 0x02000200 of the card and treats a successful reply as "free" (card does not answer while it is erasing/writing flash). Parameters used by FrmFlashHW: total timeout 10000 ms, interval 500 ms, up to 20 tries, then a further 500 ms sleep. The reply content is not inspected, only that it completed OK.
- Evidence: TGProtocolParser.SetSaveSendCardsParameters / SetSaveDistributeParameters / SetParameterStore2SpiFlash / SetParameterSender3D; AddressMapping.SaveSendCardsParametersAddr=0x01000001, ParameterStore2SpiFlashAddr=0x01000011, SaveDistributeParameterAddr=0x05000000; CommandTimeOut (SIMPLYCOMMAND 1000, SAVEPARAMS 3000, SIMPLYFILE 10000).
- Confidence: HIGH for sequence/values of the main path; MED on whether firmware needs the byte value (NovaLCT writes 0 in the main path and 1 in FrmFlashHW, so firmware probably triggers on any write; not proven).

## Q3. Calibration flash erase and the switch bit

- Erase calibration coefficients in SPI flash: write 1 byte `0x00` to **0x01000008** (CoefficientInSpiFlashErase), devType 1, per card (UC_ErasesCoefs.EraseCoefs, CorrectionGlobal.EraseCommonCorrectionCoefs). I2C flash variant is 0x01000009 (also 0x00). The same address 0x01000008 is also used by `Correction.Service TemperatureCoefsOfHWServiceBase` ("SetClearOne") with value `0x05` to clear the thermal coefficient table, followed by a free-poll. Confidence HIGH for 0x00 (coefficients); HIGH that 5 is the thermal-clear variant.
- Related calibration commands (all devType 1, 1 byte): store SDRAM -> master flash 0x01000004 (value 0; multilayer 0x010000B0); reload master flash -> SDRAM 0x01000006 (0; multilayer 0x010000B1); store SDRAM -> slave/factory flash 0x01000067 (value 5; multilayer 0x010000B7 value 0); load factory flash -> SDRAM 0x01000068 (5; multilayer 0x010000B8 value 0). There is also a ScannerSdramToSlaveFlash command that writes 0x85. (TGProtocolParser.MoveCorrection*).
- Calibration on/off switch: register **0x02000051** (CorrectionOn), 1 byte. Bit0 = enable. Bit1 = CorrectType (ProtocolEnum.CorrectType: ChromaCorrection = 0, BrightCorrection = 1; so bit1 set = brightness correction). Bit2 is set when the "retain colour info / low-gray" flag is false (`array[0] |= !retainClrInfo ? 4 : 0`). The simple overload writes 1 or 0. The per-point-correction UI masks with 0x1F. Read side (`ParseCorrectionOn`) mirrors bits 0 and 1; its bit-2 test is buggy (always "retain"). Extended switch: 0x010000B3 (CorrectionOnEx) value 5 on / 0 off; low-luminance switch 0x01000018.
- Confidence: HIGH (matches RockzaLCT's CORRECTION_STATE_BITS inference: bit0 enable, bit1 type).

## Q4. Receiving-card position in the screen layout

Finding: the sender (devType 0) holds, per Ethernet port, a 4096-byte table at `0x03000000 + 4096*port`, 1024 entries x 4 bytes. Entry for card k: **X as uint16 LE at +0, Y as uint16 LE at +2** (bytes: Xlo Xhi Ylo Yhi), at offset 4*k.
- NovaLCT actually writes it as a whole 4096-byte file per port (`TGProtocolParser.SetEthernetPortScannerXY(..., portIndex, fileName)` -> `PackageRequestWriteFile` at 0x03000000+4096*port, devType 0, file timeout 10 s). File built by `ScannerPositionFileCreator.WriteScannerPositionFile`: X lo, X hi, Y lo, Y hi per card. The list is the cards of that port sorted by their index, **repeated cyclically (index % count) to fill all 1024 entries** (MAX_PORT_LOADED_COUNT = 1024).
- Coordinates: for senders MCTRL1600 / FTSC4000_E / LP10SD1600 / KT16_ZM / MCTRL2000 / SD2000E / E8000_1 (and others in that if-list) value = card.X - min X of the port's cards, card.Y - min Y (relative to the port's top-left). For other senders the card's XInPort / YInPort is used.
- Library conflicts explained: the per-axis helpers (`SetEthernetPortScannerX/Y`) have a Y address of base+2+2 (looks like a bug, unused by the UI). The 4-byte combined helper `SetEthernetPortScannerXY(x, y)` packs `(x<<16)+y` little-endian, i.e. bytes would be Y first, X second, and its parser reads `x = low16, y = high16` - contradictory. The file-based path above (the one the UI really uses) is X then Y. Use X-first.
- Confidence: HIGH for file layout/order; MED for the "which senders use port-relative vs XInPort" split (I saw the if-list, not every enum member).
- Note: the same numeric address 0x03000000 is also the receiver-card "module run-line table" (devType 1) - different device type, different meaning (see Q8).

## Q5. Smart Settings (receiver) fields

RGB code, register **0x0200005C** (and a copy at 0x0200087E written by `SetRgbCodeCbb`; serial-drive variant 0x0200005F via `SetSerialRGBCode`). Byte = `f0 | f1<<2 | f2<<4 | f3<<6`; NovaLCT names the fields (red, green, blue, virtualRed) but treat them as **output slot 0..3**.
- Meaning: field index = output slot (first..fourth data lane of the module), field value = **which data channel feeds that slot** (0 = R, 1 = G, 2 = B, 3 = "black or red-B"). This is the "inverse" convention in RockzaLCT's terms ("slot X gets data channel r[X]").
- How I derived it (wizard `Form_AutoStepRGB` + `ConfigGuid_AutomaticParm_RGB`): it first writes identity 0,1,2,3, then paints pure GREEN (0,255,0) in the top-left of the module and cycles four trial codes every 3 s: state1 = (1,0,2,3), state2 = (0,1,2,3), state3 = (0,2,1,3), state4 = (0,2,3,1). Green is data channel 1; under "slot k is fed by channel f[k]" the green data lands on slot 0,1,2,3 in states 1..4 (one distinct slot per state - a clean sweep). Under the other reading ("channel X goes to slot f[X]") states 3 and 4 would both hit slot 2 and slot 3 would never be tested, so that reading is not what the design implies. The UI text: "look at the top-left module and choose which colour LED lights" - M0..M3 = colour seen in state 1..4 (RedA 0, Green 1, Blue 2, Black-or-RedB 3). Final code written = (M0,M1,M2,M3) as (red,green,blue,virtualRed) fields; all four must be distinct else "wrong selection" error. Serial-drive modules instead: RGBCode fixed 0,1,2,3, SerialRGBCode = M0..M3 to 0x0200005F (trial values for serial: (1,0,0,0),(0,1,0,0),(0,0,1,0),(0,0,0,1)).
- Confidence: MED-HIGH (strong design inference, not seen on hardware). Also stored in cabinet files at offset 92 (0x5C) of the 0x02 block, 2 bits per field (`CabinetConvertHelper`: `(b >> i*2) & 3`), consistent.
- OE polarity **0x0200000E**: 1 byte, `0 = HighEnable` (active high), `1 = LowEnable` (active low) (`SetOEPority`: LowEnable -> 1 else 0; ModuleOEPolarityType Unknown 255). Which one is right per module is chosen by the user via the wizard (Form_AutoStepOE; module either lights correctly or is dark/garbled). Confidence HIGH on values.
- Data direction **0x02000009** (same address as SetFieldRate in the address table): 1 byte, DataDirectionType: `0 = Horizontal`, `1 = Vertical`, 255 unknown. Effect in the algorithms: for Horizontal the scan-line index runs along Y (row) and the module width is the pixel columns; for Vertical it is swapped (scan sequence uses X). See Q8 formulas. Confidence HIGH on values, MED on physical meaning ("direction the data travels through the module").

## Q6. What the .rcfgx command records do (RAM vs flash)

| Address | Name in NovaLCT | Data seen | What it does | Persists to flash? |
|---|---|---|---|---|
| 0x0100009D | `FlashCabinetAddr`, `TGProtocolParser.WriteSaveCabinetInfo`, tag "SaveCabinetInfo" | 0x05 | Written right after the 16-byte cabinet info block (`WriteCabinetInfo` to 0x16000000) and monitor group-swap info (MonitorGroupSwapInfoAndEnAddr 0x03000780 = 50333568); 0x05 = save that cabinet info to the card's flash. Counterpart 0xA5 (tag "GetCabinetInfo") is used when READING: it loads the stored cabinet info so it can be read back from 0x16000000. | YES (cabinet-info block only) - HIGH-MED (name + save/get pair; flash is not stated in code) |
| 0x01000012 | `RecaculateParameterAddr`, `SetRecaculateParameter` | 0x00, NovaLCT waits 2000 ms (special package id 8, timeout 3) | tells the card to recompute derived parameters (gamma/brightness/refresh tables) from the registers just written. Sent to the card after settings and before/with save. | No evidence of flash; RAM recompute (MED) |
| 0x01000019 | `WriteConfigRegisterAddr` (11 bytes) | chip register data | push driver-chip configuration (gain/mask, "chipRegConfig1/Mask1") to the LED driver ICs on the module | No: drivers' registers (volatile) (MED) |
| 0x0100005E | `ConfigRegisterWrite3Addr` (11 bytes) | chip register data | same as above for the second chip-register set ("chipRegConfig2/Mask2") | No (MED) |

- Flash writers are separate registers: 0x01000011 (ParameterStore2SpiFlash, the actual "persist all parameters" trigger), 0x01000004/0x01000067 (calibration coefficients), 0x01000001 (sender), 0x05000000 (distributor). A .rcfgx that does not contain 0x01000011 will not persist the main parameter block by itself (the old-style `ScannerPropertyAccessor` file records are recorded with `IsRecordNoSend` and replayed in order; whether the .rcfgx you imported contains 0x01000011 is visible in the file - the NCP-flavoured generator emits 0x01000011 with 0x03/0x05/0x00 near the end, see Q2).
- Confidence: HIGH for names/addresses and for 0x0100009D being "save cabinet info"; MED for the others' RAM-only nature.

## Q7. Units / scales

All from `TGProtocolParser.ParseMonitorDataByBytes` etc. ReadAllStatus (receiver, devType 1) = 82 bytes at 0x0A000000:
- +0 temp flags: bit7 = valid, bit0 = negative sign. +1 temp magnitude: **value x 0.5 degC** (so raw 0x32 = 25.0 degC; sign from bit0).
- +2 humidity: `b & 0x7F` percent RH, bit7 valid.
- +3 receiver supply voltage: `(b & 0x7F) x 0.1 V`, bit7 valid (so 0x32 | 0x80 = 5.0 V).
- +0x20 (0x0A000020, 1 byte): 0xFF = monitor card attached; +0x21-22 monitor model; +0x23-26 monitor firmware version.
- Monitor card (offsets from 0x0A000000): temp flags +0x27 and value +0x28 (x0.5 degC, same sign rule), humidity +0x29 (&0x7F), smoke +0x2A (bit0 alarm, bit7 valid), 4 fans from +0x2B (1 byte each, `(b & 0x7F) x 50` rpm), 9 voltages from +0x2F (`(b&0x7F) x 0.1 V`), 8 analog inputs from +0x38 (raw), general status +0x41, module status 16 bytes from +0x42; row/line module-status info 16 bytes at +0x0B.
- Gamma (register 0x02000000, byte 0): value = `floor(gamma x 10)` in bits 0-5, bit6 (0x40) adds 0.05; `0xFE` (254) = custom gamma table in use; 0xFF treated as default 2.8; decoder: `(b & 0x3F)/10 + (bit6 ? 0.05 : 0)`; values above 4.0 are coerced to 2.8 (`ReceiverCardOperate`). So raw 28 = gamma 2.8, raw 0x40|23 = 2.35.
- Brightness: 12-bit value = (byte at 0x02000001 << 4) | (high nibble of byte at 0x020001E6); percent = value x 100 / 4095 (ReceiverCardOperate: write is `(percent*4095/100) >> 4` for the main byte).
- Sender temperature register 0x02000002 (2 bytes) is declared in AddressMapping but no decompiled code reads it (no scale known). 
- Refresh rate: no display-refresh register decoder found in the decompiled receiver code; the only frequency writer, `SendFrequency`, writes a 3-byte LE value `round(freq / 8)` to 0x0200008D (preceded by 0x05 to 0x0200008C and followed by 0x00 to 0x01000041 after a 20 ms wait) - unit is "driver clock", Hz/8 (guess for what physical quantity). Not the display refresh rate. Unresolved.
- Grayscale: coefficient tables, not scalar. Scanner gray tables are 512-byte (0x200 stride) arrays at 0x05000000 (R), 0x05000200 (G), 0x05000400 (B) (16-bit LE entries, 256 steps), 22-bit versions at +0x800 etc.; 18-bit tables at 0x2A000000+. Per-channel coefficient tables 0x21000000 (R) / 0x22000000 (G) / 0x23000000 (B), 2048 bytes each. No scalar "grayscale" unit. 
- Confidence: HIGH for temperature, humidity, voltage, fan, gamma byte, brightness; unresolved for refresh rate and sender temperature.

## Q8. Smart-settings pixel/point table generation

What NovaLCT really does (module = regular, "smart mode"):
1. The wizard collects: driver chip, module pixel cols/rows, scan type (N = 1/2/4/8/16/32...), data groups, data direction (Horizontal/Vertical), OE polarity, RGB code, rows-controlled-by-each-data-group (RowsCtrlByDataGroup), decode type, line bias.
2. The **point table is not computed from those answers: it is recorded from the user**. Step `Form_AutoStepPointDistributeNew` lights points one at a time ("run line": parameters M = width, N = logical data groups, K, black/red/white positions) and the operator marks where each lit LED appears on a grid (LedPointGrid). `GetPointDistributionOfFirstScan` returns the (x,y) of every table entry of the first scan; `SaveDistributeFile` stores them as `PointTableData` = for i in 0..TotalPointInTable-1: byte X_i, byte Y_i (module-local pixel coordinates; 0xFF,0xFF = unused entry). Grid size: cols = ModulePixelCols (Horizontal) or MaxLine(RowsCtrlByDataGroup) (Vertical), rows swapped accordingly; full line count = ceil(rows/(scan*groups))*(scan*groups).
3. Writes to the receiving card (devType 1, via `ScannerPropertyAccessor`/`ThirdGenerationScanBoardAccessorNew`):
   - **0x03000000** (ModuleRunLineTable, 1664 bytes max = 832 points) <- PointTableData (file write).
   - **0x1C000000** (469762304, Module_ScanSequenceInfo, up to 128 bytes) <- one byte per scan line: take the first valid table point of each scan s (X,Y); value_s = (Horizontal ? Y : X) of that point; then `value_s = value_s - value_0 + LineBias`. If the point table is missing/invalid: default sequence 0,1,2..N-1 (DirectCode decoders: repeating 14,13,11,7).  First point per scan for scan<=128 = first valid table point with the offset (n - lineBias) of the scan code relative to the first scan, applied to Y (Horizontal) or X (Vertical); for larger scan counts the offset is s (ascending) or -s (if the code is descending).
   - **0x0200001D** (TotalPointInTable, 2 bytes LE) <- table entry count.
   - the 0x02 block (512 bytes at 0x02000000): gamma, brightness, data direction (0x09), OE polarity (0x0E), RGB code (0x5C), module size, scan type etc. (offsets inside `ReceiverCardOperate.Scanboard02Data`; positions seen: [0]=gamma byte, [1]=brightness hi, [93..94]=MaxGamma LE, [92]=RGB code, [130]=2, [257]=32 when param-freeze, [486] hi nibble = brightness low bits).
   - **0x01000013** (GenLinearScanBoardRunLineTable, value 0): tells the card to generate its full run-line table itself from the above registers (linear, regular modules). Then 0x01000012 recalculate (2 s) and, to persist, 0x01000011.
4. Irregular cabinets / 4th-gen "CalculateRunLines" (this IS algorithmic and fully visible in `ScanBoardAccessor.RunLineDataCalculateOperate.CalculateTable`):
   Inputs: for each module m: OffsetX, OffsetY (module position in cabinet pixels), TotalPointInTable, DataDirectionType, ModuleGroupInfoArr[] = (DataGroupInCabinet g, ConnectIndex c) and ModulePointInfos[] = (X, Y, ScanIndex s, PositionIndex p, DataGroupIndex); cabinet Width; ScanType per module.
   Algorithm:
   - sort modules by OffsetX asc, then OffsetY asc.
   - physicalGroups = max(DataGroupInCabinet)+1; realGroups = distinct group count; logicalGroups L = RealDataGroupToLogicalFourthGeneration(physicalGroups, driverType) (mapping not extracted).
   - maxScan = max ScanType; groupTotal[g] = sum of TotalPointInTable of modules in g; maxSum = max_g groupTotal[g].
   - reverse connect order inside each group: c' = maxC_g - c + 1.
   - table T[g][s][i] initialised to sentinel 0x50FFFFFF (1358954495) for g<L, s<maxScan, i<maxSum.
   - for each module/group-slot: offsetPoint = maxSum - groupTotal[g]; connectPoint = sum of TotalPointInTable of modules in that group whose c' < this module's c'; for each ModulePointInfo with X>=0 or Y>=0: T[g][s][ p + connectPoint + offsetPoint ] = (X + OffsetX, Y + OffsetY).
   - output int32 array in order **for s in 0..maxScan-1, for i in 0..maxSum-1, for g in 0..L-1**: if either coordinate is sentinel -> 0x50FFFFFF else `Y * CabinetWidth + X`. `IsLargePayLoad` is forced true => each int written as 4 bytes LE (2-byte LE if false). Total size = maxScan*maxSum*L*4.
   Worked example: cabinet width 8, one module at offset (0,0), 1 group (g=0, c=1), maxScan=2, TotalPointInTable=3, L=1; points scan0: p0=(0,0) p1=(1,0) p2=(2,0); scan1: (0,1),(1,1),(2,1). c' = 1-1+1 = 1, connectPoint = 0, offsetPoint = 0. Output ints: s0: 0,1,2; s1: 8,9,10 -> bytes `00 00 00 00 | 01 00 00 00 | 02 00 00 00 | 08 00 00 00 | 09 00 00 00 | 0A 00 00 00`. Two modules in one group: second module's points shift by the first module's TotalPointInTable (or are placed after, depending on reversed connect order) and unused tail entries stay 0x50FFFFFF.
   This table goes to the 4th-gen/NCP path (record `ScanBoardObjectPointTable`, `SetScanBoardRunLineTableNew`, address family 0x04000000 / 0x03000000 depending on card generation).
- What remains unknown: (a) `RealDataGroupToLogicalFourthGeneration` mapping; (b) the chip-specific part of the wizard (`ChipAutoSetFactory.*`, per-driver-chip register images in Nova.LCT.ChipToolCore / chip plugin DLLs); (c) the user-interactive run-line identification cannot be reproduced without the operator; a RockzaLCT equivalent would have to ask the user to mark points or accept an imported .rcfgx; (d) 0x04000000 exact byte format for the 3rd-gen scanner alignment table (only seen as `Scanner_scannerAlignmentTableBase` and the cabinet algorithm above).
- Confidence: HIGH for the 4th-gen CalculateTable algorithm and the scan-sequence formula; HIGH for register addresses/sizes; MED that the wizard output equals the layout described (wizard path is split over many classes).

---

## Unverified / not found
- Whether firmware ignores the data byte of the save triggers (0 vs 1): both seen.
- Display refresh rate unit; sender temperature scale.
- Per-chip register images from the Smart wizard.
- ControlModeType (1/2) is never written in the decompiled set; if another assembly (not decompiled: ~280 DLLs skipped, e.g. Mars/SI.* controllers) does, it was not seen.
