import { describe, expect, it } from 'vitest';
import { recorderFailure } from './useRecorder';

describe('recorderFailure', () => {
  it('tells a refused permission from a missing microphone from any other failure', () => {
    expect(recorderFailure('NotAllowedError')).toBe('denied');
    expect(recorderFailure('SecurityError')).toBe('denied');
    expect(recorderFailure('NotFoundError')).toBe('missing');
    expect(recorderFailure('OverconstrainedError')).toBe('missing');
    expect(recorderFailure('NotReadableError')).toBe('error');
    expect(recorderFailure('')).toBe('error');
  });
});
