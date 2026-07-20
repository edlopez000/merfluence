// Unit-project (jsdom) setup: jest-dom matchers for the Testing Library view
// tests, and an automatic DOM cleanup between cases so a mounted <App> from one
// test can't leak into the next.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
