import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `@testing-library/react`'s auto-cleanup only registers itself when it finds `afterEach`
// on the global scope, which requires `test.globals: true` in vitest.config.ts. This project
// imports test globals explicitly instead, so without this, renders from earlier tests in the
// same file leak into later ones (e.g. `getByRole` starts matching more than one button).
afterEach(cleanup);
