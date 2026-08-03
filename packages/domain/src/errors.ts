export class NotImplementedFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedFlowError';
  }
}
