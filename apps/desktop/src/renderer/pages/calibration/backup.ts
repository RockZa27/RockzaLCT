import {
  COEFFICIENT_REGION,
  buildCoefficientFile,
  coefficientIoFromApi,
  downloadCoefficients,
  serializeCoefficientFile,
  type CalibrationApi,
  type CoefficientTransferOptions,
  type CoefficientTransferResult,
} from '@rockzalct/shared';
import { coefficientFileName, downloadTextFile } from './fileIo';

/** True only for a backup of the card's entire coefficient region — the only kind that unlocks store / erase. */
export const isFullCoefficientBackup = (range: { offset: number; length: number }): boolean =>
  range.offset === 0 && range.length === COEFFICIENT_REGION.sizeBytes;

/**
 * Read a card's coefficients and, only when the whole range was read, trigger the file download.
 * `fileName` is set exactly when the download was triggered (that is what unlocks store / erase).
 */
export async function backupCard(
  api: Pick<CalibrationApi, 'readCoefficientBlock' | 'writeCoefficientBlock'>,
  id: string,
  info: { model: string; firmwareVersion: string } | null,
  card: { portIndex: number; cardIndex: number },
  offset: number,
  length: number,
  options: CoefficientTransferOptions,
): Promise<{ result: CoefficientTransferResult; fileName?: string }> {
  const io = coefficientIoFromApi(api, id, card.portIndex, card.cardIndex);
  const res = await downloadCoefficients(io, offset, length, options);
  if (!res.ok) return { result: res };
  const file = buildCoefficientFile({
    controller: { model: info?.model ?? '', firmwareVersion: info?.firmwareVersion ?? '' },
    portIndex: card.portIndex,
    cardIndex: card.cardIndex,
    offset,
    data: res.data,
  });
  const fileName = coefficientFileName(card.portIndex, card.cardIndex);
  downloadTextFile(fileName, serializeCoefficientFile(file));
  return { result: res, fileName };
}
