/** What a mock feature gets from createMockDevice. */
export interface MockContext {
  /** Throws NOT_FOUND / NOT_CONNECTED like the real service. */
  requireConnected(id: string): void;
  /** Simulated device latency. */
  delay(): Promise<void>;
  isAdvanced(): boolean;
}
