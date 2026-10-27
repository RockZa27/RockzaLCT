import type { PersistApi } from '@rockzalct/shared';
import type { MockContext } from './context';

export function createMockPersist(_ctx: MockContext): PersistApi {
  return {};
}
