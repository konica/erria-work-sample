import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/generated/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
);
