import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

const sharedRules = {
  'no-unused-vars': [
    'warn',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'none',
      // `const { id, enabled, ...rest } = rule` is the idiom used to omit keys.
      ignoreRestSiblings: true
    }
  ],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-control-regex': 'off'
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      'client/build/**',
      'client/src/config/generatedPorts.js',
      'server/storage/**',
      'server/certs/**',
      'server/logs/**'
    ]
  },
  js.configs.recommended,

  // Backend, launchers, scripts and the client's tool configs: CommonJS on Node.
  {
    files: ['server/**/*.js', 'scripts/**/*.js', '*.js', 'client/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: globals.node
    },
    rules: sharedRules
  },

  // Frontend: React with JSX in .js files (Create React App convention).
  {
    files: ['client/src/**/*.{js,jsx}'],
    ...react.configs.flat.recommended,
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: globals.browser
    },
    plugins: {
      react,
      'react-hooks': reactHooks
    },
    settings: {
      react: { version: 'detect' }
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...sharedRules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      // Render helpers returning JSX (react-json-tree label renderers) are
      // not components; revisit when the client is split into modules.
      'react/display-name': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
]
