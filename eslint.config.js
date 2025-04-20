import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default [
    {
        files: ["**/*.ts", "**/*.tsx"],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: true,
                tsconfigRootDir: __dirname,
            },
            sourceType: "module",
        },
        plugins: {
            "@typescript-eslint": tsPlugin,
            prettier: eslintPluginPrettier,
        },
        rules: {
            ...eslintPluginPrettier.configs.recommended.rules,
            ...tsPlugin.configs["recommended"].rules,
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": "warn",
        },
    },
    {
        ignores: ["dist/**/*", "node_modules/**/*"],
    },
    eslintConfigPrettier,
];