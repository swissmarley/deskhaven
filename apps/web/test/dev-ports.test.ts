import { describe, expect, it } from 'vitest';
import { devPorts } from '../config/dev-ports.js';

describe('devPorts', () => {
  it('defaults to 8787 for the API and 5173 for the web dev server', () => {
    expect(devPorts({})).toEqual({ api: 8787, web: 5173 });
  });

  it('reads the server variables, with the old names as fallback', () => {
    expect(devPorts({ DESKHAVEN_PORT: '9000', DESKHAVEN_DEV_WEB_PORT: '5200' })).toEqual({
      api: 9000,
      web: 5200,
    });
    expect(devPorts({ AGENTHOTEL_PORT: '9100' })).toEqual({ api: 9100, web: 5173 });
  });

  it('ignores values that are not ports', () => {
    expect(devPorts({ DESKHAVEN_PORT: 'abc', DESKHAVEN_DEV_WEB_PORT: '70000' })).toEqual({
      api: 8787,
      web: 5173,
    });
  });
});
