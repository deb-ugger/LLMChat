export function wtpHashes(text: string): BigInt64Array;
export function predictWtpBoundaries(text: string, infer: (text: string) => Promise<readonly number[]>, threshold?: number): Promise<number[]>;
