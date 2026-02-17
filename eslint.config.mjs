import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**"],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-non-null-assertion": "warn",
            "no-console": "off",
            "semi": ["error", "always"],
            "quotes": ["error", "double", { "avoidEscape": true }],
        },
    }
);
