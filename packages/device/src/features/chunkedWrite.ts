// One register write, split into the connection's own chunks. Shared by the .rcfgx import and the
// pixel-mapping wizard so both use the same mechanism.
//
// The chunk size is the connection's (`maxLength`), never ours: Request.makeChunks splits a record
// into consecutive-address chunks, each sent with connection.send (acknowledged unless broadcast; a
// broadcast chunk is followed by the library's own 50 ms pause).
import { Request } from '@novastar/codec';

/** The slice of the codec connection used for writing. */
export interface ChunkConnection {
  maxLength: number;
  send(req: Request<boolean>): Promise<unknown>;
}

/**
 * Send `req` in chunks of `conn.maxLength`. `onChunk` runs after each acknowledged chunk (progress).
 */
export async function sendChunked(
  conn: ChunkConnection,
  req: Request<boolean>,
  broadcast: boolean,
  onChunk?: (chunk: Request<boolean>) => void,
): Promise<void> {
  for (const chunk of Request.makeChunks(req, conn.maxLength)) {
    // makeChunks builds the 2nd..nth chunk from a bare Packet and drops the broadcast flag
    // (codec 2.2.3: only a Request source copies it), which would make the connection wait
    // for acknowledgements a broadcast never gets. Set it back on every chunk.
    (chunk as { broadcast: boolean }).broadcast = broadcast; // typed readonly, a plain field at run time
    await conn.send(chunk);
    onChunk?.(chunk);
  }
}
